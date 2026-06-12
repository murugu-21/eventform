# Eventform Deployment Guide

This is the step-by-step handoff checklist to get eventform running at
`eventform.murugappan.dev` / `eventform-api.murugappan.dev` on a generic VPS.

**AWS is used only for Cognito (free tier).** Everything else — Kafka, KMS,
Postgres, Caddy — runs inside Docker on the VPS. There is no EC2, no ECS,
no RDS.

---

## Step 1: AWS account + CDK bootstrap

You need an AWS account. Cognito stays well within the free tier (50 000 MAU).

```bash
# Install the AWS CLI and configure credentials for your account
aws configure

# Bootstrap CDK in your target region (us-east-1 recommended for Cognito)
cd infra/cdk
pnpm install
pnpm exec cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

CDK bootstrap provisions the S3 bucket and IAM roles that `cdk deploy` uses.
This is a one-time per-account/region step.

---

## Step 2: Google Cloud OAuth client

Cognito uses Google as the identity provider. You need a Google OAuth 2.0
client to hand to CDK.

1. Open [Google Cloud Console](https://console.cloud.google.com) →
   **APIs & Services** → **Credentials** → **Create credentials** →
   **OAuth 2.0 Client ID**.
2. Application type: **Web application**.
3. Add the following to **Authorized redirect URIs**:
   ```
   https://<cognitoDomainPrefix>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
   ```
   Replace `<cognitoDomainPrefix>` with the value you will pass to CDK
   (default: `eventform-auth`).
4. Save the **Client ID** and **Client Secret** — you will pass them to CDK
   in the next step.

---

## Step 3: Deploy AuthStack to AWS

```bash
cd infra/cdk
pnpm exec cdk deploy AuthStack \
  -c googleClientId=YOUR_GOOGLE_CLIENT_ID \
  -c googleClientSecret=YOUR_GOOGLE_CLIENT_SECRET \
  -c cognitoDomainPrefix=eventform-auth \
  -c webHost=eventform.murugappan.dev
```

CDK will print three outputs — save them:

| Output | Description | Used in |
|---|---|---|
| `AuthStack.IssuerUrl` | `https://cognito-idp.us-east-1.amazonaws.com/<poolId>` | `COGNITO_ISSUER` env var |
| `AuthStack.ClientId` | Cognito app client ID | `COGNITO_CLIENT_ID` env var |
| `AuthStack.HostedDomainUrl` | `https://eventform-auth.auth.us-east-1.amazoncognito.com` | `VITE_COGNITO_DOMAIN` build arg (Caddy image) |

**Note:** The Caddy image bakes the Cognito domain into the static JS bundle at
build time (Vite env vars). Re-building the Caddy image is required if the Cognito
domain ever changes.

---

## Step 4: VPS — provider, sizing, DNS, cloud-init

### Provider comparison (pick one)

| Provider | Instance | RAM | Cost | Notes |
|---|---|---|---|---|
| Hetzner | CX22 | 4 GB | ~€4.5/mo | Best price/performance for EU |
| DigitalOcean | Droplet Basic | 2 GB | ~$6/mo | Simple UI, good docs |
| Vultr | Cloud Compute | 2 GB | ~$6/mo | US + EU locations |

**Minimum:** 2 GB RAM. Kafka + Debezium together use ~700 MB.

### DNS

Point two A records at the VPS IPv4 address:
- `eventform.murugappan.dev`
- `eventform-api.murugappan.dev`

Allow a few minutes for propagation. Caddy will automatically obtain Let's
Encrypt TLS certificates once the DNS resolves.

### Optional cloud-init snippet (Ubuntu 22.04/24.04)

Paste this as **User data** when creating the VPS to auto-install Docker and
clone the repo:

```yaml
#cloud-config
packages:
  - docker.io
  - docker-compose-plugin
  - git
runcmd:
  - systemctl enable --now docker
  - usermod -aG docker ubuntu
  - mkdir -p /opt/eventform
  - git clone https://github.com/murugu-21/eventform /opt/eventform
  - chown -R ubuntu:ubuntu /opt/eventform
```

SSH in as `ubuntu` after the VPS boots (~90 s).

---

## Step 5: First-time setup on the VPS

### 5a. Write the `.env` file

```bash
cd /opt/eventform/infra/compose
cp /dev/null .env   # start empty
```

Edit `.env` with the following variables. All are required unless marked optional.

| Variable | Description | Example |
|---|---|---|
| `DB_ADMIN_PASSWORD` | Postgres superuser password | `$(openssl rand -hex 20)` |
| `APP_API_PASSWORD` | Password for the `app_api` DB role (rotated by bootstrap.sh in step 5e) | `$(openssl rand -hex 20)` |
| `APP_WORKER_PASSWORD` | Password for the `app_worker` DB role (rotated by bootstrap.sh in step 5e) | `$(openssl rand -hex 20)` |
| `KMS_KEY_MATERIAL_FILE` | Absolute host path for the AES-256 key material file (created by gen-kms-material.sh in step 5b) | `/etc/eventform/kms-material.b64` |
| `COGNITO_ISSUER` | From CDK AuthStack output `IssuerUrl` | `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123` |
| `COGNITO_CLIENT_ID` | From CDK AuthStack output `ClientId` | `1abc2defg3hijkl` |
| `ACME_EMAIL` | Email for Let's Encrypt registration | `you@example.com` |
| `WEB_HOST` | *(optional)* Web hostname; default `eventform.murugappan.dev` | |
| `API_HOST` | *(optional)* API hostname; default `eventform-api.murugappan.dev` | |
| `AWS_REGION` | *(optional)* AWS region; default `us-east-1` | |

> **First-boot order matters.** KMS key material must exist *before* compose
> starts (localstack mounts it), and the `app_api`/`app_worker` roles must exist
> *before* their passwords can be rotated (the migration creates them). Run
> 5b → 5h in order; each step is idempotent and safe to re-run.

### 5b. Generate KMS key material (before anything starts)

```bash
export KMS_KEY_MATERIAL_FILE=/etc/eventform/kms-material.b64
bash /opt/eventform/infra/prod/gen-kms-material.sh
```

Creates an AES-256 key material file (mode 600) if missing. **Back this file
up** — losing it makes all encrypted endpoint secrets irrecoverable. Idempotent:
re-running leaves an existing file untouched.

### 5c. Start the infra tier

```bash
cd /opt/eventform/infra/compose
docker compose -f docker-compose.prod.yml up -d postgres localstack kafka connect
docker compose -f docker-compose.prod.yml wait postgres localstack kafka connect
```

### 5d. Run migrations (creates tables, roles, RLS policies)

```bash
docker compose -f docker-compose.prod.yml run --rm migrate
```

The `migrate` service uses profile `setup`; you can also run
`docker compose -f docker-compose.prod.yml --profile setup up migrate`.

### 5e. Harden the database (rotate role passwords + revoke CREATE)

Runs *after* migrations, because it alters the `app_api`/`app_worker` roles the
migration just created. It refuses to run (with a clear message) if those roles
or the postgres container are missing.

```bash
export DB_ADMIN_PASSWORD=...      # same value as in .env
export APP_API_PASSWORD=...       # same value as in .env
export APP_WORKER_PASSWORD=...    # same value as in .env
bash /opt/eventform/infra/prod/bootstrap.sh
```

### 5f. Register the Debezium connector

The `connect-init` service is a one-shot `curl` container that registers the
connector on every `compose up`. It starts automatically with the full stack (step 5h).

In prod the connector config is `infra/compose/connect/eventform-outbox-prod.json`,
which substitutes `${DB_ADMIN_PASSWORD}` at registration time.

### 5g. Deploy KmsStack into LocalStack (optional but recommended)

For fresh environments, deploying `KmsStack` first pins the key ID so that any
ciphertext you create remains valid across LocalStack restarts.

```bash
# On the VPS, with docker compose up
cd /opt/eventform/infra/cdk
pnpm install
AWS_ENDPOINT_URL=http://localhost:4566 pnpm exec cdklocal deploy KmsStack \
  --require-approval never
```

If you skip this step, the boot hook (`infra/compose/localstack/ready.d/01-import-kms-key.sh`)
creates the key and imports material automatically. The two mechanisms are
compatible — the boot hook is the fallback and the healing mechanism on restarts.

### 5h. Start the full application stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

The `connect-init` one-shot service registers the connector and exits.
Caddy obtains TLS certificates automatically; allow 30–60 s for ACME.

---

## Step 6: GitHub repository secrets and variables

Configure these in **Settings → Secrets and variables → Actions** under a
`production` environment.

### Secrets

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS IPv4 or hostname |
| `VPS_USER` | SSH user (e.g. `ubuntu`) |
| `VPS_SSH_KEY` | Private SSH key (PEM format; the corresponding public key must be in `~/.ssh/authorized_keys` on the VPS) |

### Repository variables (used as Caddy image build args)

| Variable | Value |
|---|---|
| `VITE_COGNITO_DOMAIN` | `https://eventform-auth.auth.us-east-1.amazoncognito.com` |
| `VITE_COGNITO_CLIENT_ID` | Your Cognito app client ID |
| `VITE_REDIRECT_URI` | `https://eventform.murugappan.dev/auth/callback` |

**Note on the VPS_HOST secret gate:** GitHub Actions does not allow evaluating
secrets directly in `if:` conditions. The deploy workflow uses an env-var
indirection (`VPS_HOST_CONFIGURED`) — if the secret is absent the deploy job
posts a workflow notice and exits cleanly rather than failing.

Once secrets are set, push a `v*` tag to trigger a full build + deploy:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Or trigger manually via **Actions → Deploy → Run workflow**.

---

## Step 7: Smoke checklist

After the first deploy, verify the following manually:

- [ ] `https://eventform.murugappan.dev` loads the React SPA (green padlock)
- [ ] `https://eventform-api.murugappan.dev/health` returns `{"status":"ok"}`
- [ ] Clicking **Continue with Google** redirects to accounts.google.com
- [ ] After Google sign-in, the SPA lands on `/app` (Cognito PKCE flow completes)
- [ ] Create a form, publish it, copy the public link
- [ ] Submit the public form anonymously
- [ ] The delivery appears as `delivered` in the Deliveries dashboard

### Recruiter demo script (5 minutes)

> "I'll show you the full event-driven pipeline live."

1. Sign in with Google → land on `/app`.
2. Create a form called **Demo**, add a Text field "Favourite language", publish.
3. Open the public link in a new tab — show the form renders without auth.
4. Go to **Endpoints** → New endpoint → paste `https://webhook.site/<your-id>` →
   create → save the `whsec_` secret.
5. Return to the public form tab, fill in `TypeScript`, submit.
6. Switch to **Deliveries** — delivery appears in ~5 s.
7. Open webhook.site — show the signed payload with `X-Eventform-Signature` and
   `X-Eventform-Event-Id` headers.
8. To demo failure + retry: update the endpoint URL to `https://httpstat.us/500`,
   submit another response, watch the delivery fail with `500` in the attempt log,
   then restore the URL and hit **Retry**.

---

## Step 8: Teardown and ongoing costs

| Resource | Monthly cost | Notes |
|---|---|---|
| VPS (Hetzner CX22) | ~€4.5 | Includes all containers |
| AWS Cognito | $0 | 50 000 MAU free tier |
| AWS KMS | $0 | LocalStack runs on VPS — no AWS KMS API calls |
| Domain | already owned | |
| **Total** | **~€4–6/mo** | |

### Teardown

```bash
# Stop and remove all containers and volumes
docker compose -f docker-compose.prod.yml down -v

# Remove images
docker image prune -a
```

To delete the Cognito resources from AWS:
```bash
cd infra/cdk
pnpm exec cdk destroy AuthStack \
  -c googleClientId=placeholder \
  -c googleClientSecret=placeholder
```

The UserPool has `removalPolicy: RETAIN` to protect user data. Override with
`--force` only if you are certain you want to delete it.
