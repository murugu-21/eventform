# EventForm Deployment Guide

Step-by-step runbook to deploy EventForm at `eventform.murugappan.dev` /
`eventform-api.murugappan.dev`.

**Architecture at a glance:**

| Layer | Where it runs |
|---|---|
| Frontend (SPA) | **Cloudflare Pages** (global CDN; always up, independent of the backend) |
| Ingress | **Cloudflare Tunnel** → `api:3001` directly (outbound-only, zero inbound ports, no reverse proxy) |
| Compute (API + worker + Redpanda + Debezium) | **AWS EC2 Auto Scaling Group** (Graviton `t4g.small`), Docker Compose, `ap-south-1` |
| Database | **Neon** (managed serverless Postgres + PITR), `ap-southeast-1` |
| Auth | **AWS Cognito** + Google IdP (free tier), `us-east-1` |
| Endpoint-secret encryption | In-process **AES-256-GCM** (no KMS, no LocalStack) |
| Secrets at boot | **AWS SSM Parameter Store** (`/eventform/*`, SecureString) |

The EC2 box is **stateless** — Postgres is on Neon and the only on-box state
(the Redpanda log) is disposable, so the ASG can recycle/scale it freely. No
credentials are committed anywhere: the DB migration creates roles password-less
and passwords are applied from env.

> **Regions:** The EC2 ASG runs in **`ap-south-1`** (Mumbai) — the cheapest
> Graviton `t4g` region. Neon has no Mumbai region, so the database sits in
> **`ap-southeast-1`** (Singapore), the nearest option, and the API↔DB hop is
> **cross-region (~50–65 ms RTT)** — acceptable for a demo/recruiter-testing box.
> (To co-locate compute with the DB instead, deploy ComputeStack to
> `ap-southeast-1`.) Cognito stays in **`us-east-1`** (and CertStack, if used,
> *must* be us-east-1 for CloudFront) — JWKS is fetched cross-region and cached.

---

## Prerequisites (one-time accounts)

- **AWS account** with the CLI configured (`aws configure`).
- **Neon account** (https://neon.com).
- **Cloudflare account** with `murugappan.dev` on Cloudflare DNS.
- **Google Cloud OAuth client** (for Cognito federation).
- Node 22 + pnpm locally.

---

## Step 1 — AWS: bootstrap CDK (both regions)

```bash
cd infra/cdk && pnpm install
pnpm exec cdk bootstrap aws://ACCOUNT_ID/us-east-1   # Cognito (+ CertStack)
pnpm exec cdk bootstrap aws://ACCOUNT_ID/ap-south-1  # ComputeStack (Mumbai)
```

## Step 2 — Google OAuth client

1. [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services
   → Credentials → Create credentials → OAuth 2.0 Client ID** (Web application).
2. Authorized redirect URI:
   ```
   https://<cognitoDomainPrefix>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
   ```
   (default prefix `eventform-auth`; if using the branded `auth.murugappan.dev`
   domain, also add its `/oauth2/idpresponse`).
3. Save the **Client ID** and **Client Secret**.

## Step 3 — Deploy AuthStack (Cognito, us-east-1)

```bash
cd infra/cdk
CDK_DEFAULT_REGION=us-east-1 pnpm exec cdk deploy AuthStack \
  -c googleClientId=YOUR_GOOGLE_CLIENT_ID \
  -c googleClientSecret=YOUR_GOOGLE_CLIENT_SECRET \
  -c cognitoDomainPrefix=eventform-auth \
  -c webHost=eventform.murugappan.dev
# branded hosted UI (optional): also deploy CertStack with -c customAuthDomain=auth.murugappan.dev
```

Save the outputs: `IssuerUrl` → `COGNITO_ISSUER`, `ClientId` → `COGNITO_CLIENT_ID`,
hosted domain → `VITE_COGNITO_DOMAIN`.

## Step 4 — Neon (database)

1. **Create a project** in **`ap-southeast-1`** (Singapore) — the nearest Neon
   region to the Mumbai compute box (Neon has no `ap-south-1`).
2. **Enable logical replication** (Project → Settings → **Logical replication**).
   Debezium CDC requires `wal_level=logical`; without it the connector cannot
   create its replication slot.
3. Grab two connection strings from the Neon console:
   - **DIRECT** endpoint (the non-`-pooler` host) → `DATABASE_URL` (owner role,
     e.g. `neondb_owner`). **Debezium and migrations must use the direct host** —
     logical replication does not work through Neon's pooler.
   - The **pooled** endpoint is fine for the app roles (Step 4b).
4. **Run migrations** against Neon (creates tables, RLS, and the
   password-less `app_api`/`app_worker` roles):
   ```bash
   DATABASE_URL='postgres://<owner>:<pw>@<direct-host>/neondb?sslmode=require' pnpm db:migrate
   ```

### Step 4b — Set app-role passwords (one-time) and assemble app URLs

The migration creates `app_api`/`app_worker` with **no password**. Apply real
passwords from env, then build the app connection URLs:

```bash
DATABASE_URL='postgres://<owner>:<pw>@<direct-host>/neondb?sslmode=require' \
APP_API_PASSWORD='<strong-secret>' \
APP_WORKER_PASSWORD='<strong-secret>' \
pnpm db:roles
```

Then:
- `DATABASE_URL_API`    = `postgres://app_api:<APP_API_PASSWORD>@<pooled-host>/neondb?sslmode=require`
- `DATABASE_URL_WORKER` = `postgres://app_worker:<APP_WORKER_PASSWORD>@<pooled-host>/neondb?sslmode=require`

(Neon passwords must satisfy its complexity policy — use real generated secrets,
not the placeholders.)

## Step 5 — Secrets into SSM Parameter Store (ap-south-1)

The EC2 instance reads these at boot from **its own region** (its IAM role grants
read on `arn:aws:ssm:<compute-region>:…:parameter/eventform/*`), so the params
must live in the **compute region — `ap-south-1`**, not where Neon is.
Create each as a **SecureString** in **`ap-south-1`**:

```bash
R=ap-south-1
put() { aws ssm put-parameter --region $R --type SecureString --overwrite --name "$1" --value "$2"; }
put /eventform/database-url        'postgres://<owner>:<pw>@<direct-host>/neondb?sslmode=require'
put /eventform/database-url-api    'postgres://app_api:<pw>@<pooled-host>/neondb?sslmode=require'
put /eventform/database-url-worker 'postgres://app_worker:<pw>@<pooled-host>/neondb?sslmode=require'
put /eventform/secret-enc-key      "$(head -c 32 /dev/urandom | base64)"
put /eventform/tunnel-token        '<cloudflare-tunnel-token>'   # from Step 6
put /eventform/cognito-issuer      '<AuthStack IssuerUrl>'
put /eventform/cognito-client-id   '<AuthStack ClientId>'
```

> **Back up `secret-enc-key` out of band.** A Neon dump without it is
> ciphertext-only for endpoint secrets, and losing it orphans every stored secret.

## Step 6 — Cloudflare (Pages + Tunnel)

**Pages (frontend):**
1. Create the project: `npx wrangler pages project create eventform` (name must
   be `eventform` to match `deploy-web.yml`).
2. Pages → **Custom domains** → add `eventform.murugappan.dev`.

**Tunnel (API ingress):**
1. Dashboard → **Networks → Tunnels → Create a tunnel** (Cloudflared). Name it
   `eventform`; copy the **token** into SSM as `/eventform/tunnel-token` (Step 5).
2. **Public Hostnames** → add `eventform-api.murugappan.dev` → `HTTP://api:3001`
   (cloudflared shares the compose network and reaches the `api` service directly).
   Do **not** add a hostname for `eventform.murugappan.dev` — Pages owns it.

`auth.murugappan.dev` (Cognito) is unrelated to the tunnel — its DNS-only CNAME
to CloudFront stays as configured.

## Step 7 — Build & publish images, deploy the SPA

Configure GitHub **Settings → Secrets and variables → Actions** (`production` environment).

**Secrets:**

| Secret | Used by |
|---|---|
| `NEON_DATABASE_URL` (owner, DIRECT host) | `deploy.yml` → `migrate` job |
| `CLOUDFLARE_API_TOKEN` (scope: *Cloudflare Pages: Edit*) | `deploy-web.yml` — *skip if you build the SPA on Cloudflare Pages directly* |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-web.yml` — *ditto* |

> **No AWS access keys.** The `rollout` job authenticates to AWS via **GitHub OIDC**,
> assuming the `eventform-github-deploy` role that ComputeStack creates (trust scoped
> to this repo's `production` environment). You only record its ARN as a variable —
> available after Step 8.

**Variables:**

| Repository Variable | Value |
|---|---|
| `AWS_ROLE_ARN` | ComputeStack's `GithubDeployRoleArn` output (set **after** Step 8) — enables the keyless ASG rollout |
| `AWS_REGION` | `ap-south-1` *(optional — already the default)* |
| `VITE_API_URL` | `https://eventform-api.murugappan.dev` *(VITE\_\* only if building the SPA via `deploy-web.yml`; if building on Cloudflare Pages, set them there instead)* |
| `VITE_AUTH_MODE` | `cognito` |
| `VITE_COGNITO_DOMAIN` | `https://auth.murugappan.dev` (branded) or the amazoncognito.com hosted domain |
| `VITE_COGNITO_CLIENT_ID` | Cognito app client ID |
| `VITE_REDIRECT_URI` | `https://eventform.murugappan.dev/auth/callback` |

- **Backend images:** push a `v*` tag → `deploy.yml` builds **multi-arch
  (amd64 + arm64)** images to GHCR (`ghcr.io/murugu-21/eventform-*`). Ensure the
  packages are **public** (GHCR → package → visibility) so the EC2 box can pull
  without auth.
  ```bash
  git tag v1.0.0 && git push origin v1.0.0
  ```
- **Frontend:** `deploy-web.yml` runs on pushes to `main` touching `apps/web/**`
  (or via **Actions → Deploy Web → Run workflow**) and ships the SPA to Pages.

## Step 8 — Deploy the compute (EC2 ASG)

```bash
cd infra/cdk
# Pass the Cognito issuer + app client id so the scale-to-zero WAKE endpoint
# (API Gateway + Cognito authorizer) is provisioned. Omit them and the stack
# still deploys, just without the wake endpoint (the box won't auto-start).
CDK_DEFAULT_REGION=ap-south-1 pnpm exec cdk deploy ComputeStack \
  -c cognitoIssuer="$(aws ssm get-parameter --region ap-south-1 --name /eventform/cognito-issuer --query Parameter.Value --output text)" \
  -c cognitoClientId="$(aws ssm get-parameter --region ap-south-1 --name /eventform/cognito-client-id --query Parameter.Value --output text)"
```

This creates the launch template (`t4g.small`, AL2023 ARM, 16 GB gp3, IMDSv2),
the ASG (min 0 / max 1 / desired 1), an instance role (SSM Session Manager +
read `/eventform/*`), and a security group with **no inbound** ports. On boot the
userdata installs Docker, clones the repo, materializes `.env` from SSM, runs
`docker compose -f docker-compose.prod.yml up -d`, and installs the
`eventform-idle.timer` (scale-to-zero idle-stop). Migrations run in CI against
Neon (the deploy workflow's `migrate` job), not on the box. Debezium Server starts
streaming from Neon on its own — it parses the connector config from env and needs
no registration step — and `cloudflared` dials out to the tunnel.

It also provisions the **scale-to-zero wake endpoint** (HTTP API Gateway +
Cognito authorizer + Lambda). Copy the stack's **`WakeUrl`** output into the
SPA's **`VITE_WAKE_URL`** (Cloudflare Pages env) and redeploy the SPA, so the
`ApiHealthGate` can start the box on the first authenticated visit.

It also provisions the **GitHub OIDC provider + `eventform-github-deploy` role**
(keyless CI deploys). Copy the stack's **`GithubDeployRoleArn`** output into the
`AWS_ROLE_ARN` GitHub variable (Step 7); the `rollout` job then assumes it on each
`v*` tag — no AWS keys stored. (The first tag pushed *before* this is set just
skips the rollout cleanly; re-tag or re-run after setting it.)

**Shell access** (no SSH, no inbound): `aws ssm start-session --target <instance-id>`.

---

## Step 9 — Smoke checklist

- [ ] `https://eventform.murugappan.dev` loads the SPA from Pages (green padlock)
- [ ] `https://eventform-api.murugappan.dev/health` → `{"status":"ok"}` (give the box ~3–4 min on first boot: image pulls + Redpanda/Debezium healthy)
- [ ] **Continue with Google** → accounts.google.com → lands on `/app` (Cognito PKCE)
- [ ] Create a form, publish, copy the public link
- [ ] Submit the public form anonymously
- [ ] Delivery shows `delivered` in the Deliveries dashboard (CDC → webhook works on Neon)
- [ ] **Resilience:** stop the API (`aws ssm start-session` → `docker compose -f /opt/eventform/infra/compose/docker-compose.prod.yml stop api`), reload `/login` → shows "Waking up the backend"; landing page still loads. Start it again → reconnects on its own.

### Recruiter demo (5 minutes)

1. Sign in with Google → `/app`.
2. Create a form **Demo**, add a Text field "Favourite language", publish.
3. Open the public link in a new tab — renders without auth.
4. **Endpoints** → New → `https://webhook.site/<your-id>` → save the `whsec_` secret.
5. Submit `TypeScript` on the public form.
6. **Deliveries** — delivery appears in a few seconds.
7. webhook.site shows the signed payload with `X-Eventform-Signature` + `X-Eventform-Event-Id`.
8. Failure+retry: point the endpoint at `https://httpstat.us/500`, submit again, watch it fail with `500`, then restore the URL and hit **Retry**.

---

## Operations

### Scaling the box (automatic scale-to-zero)

The ASG (min 0 / max 1) scales itself:

- **Scale-down (idle):** an on-box `systemd` timer (`eventform-idle.timer`, every
  5 min) runs `idle-check.sh`. When there have been no real (non-`/health`)
  requests for 30 min, the box sets its own ASG to desired 0 and terminates.
  Free — no CloudWatch metrics.
- **Scale-up (wake):** the SPA's `ApiHealthGate` `POST`s the `WakeUrl` (API
  Gateway + Cognito authorizer) when it sees the API down; a Lambda sets desired
  1 and a fresh instance boots (~3–4 min cold start). Cognito-only — anonymous
  visitors don't auto-wake.

A new instance is stateless: userdata re-pulls images and `compose up`s; Postgres
data is safe on Neon. Manual override (e.g. to force it up for a demo, or down to
save cost):

```bash
ASG=$(aws autoscaling describe-auto-scaling-groups --region ap-south-1 \
  --query "AutoScalingGroups[?contains(AutoScalingGroupName,'ComputeStack')].AutoScalingGroupName" --output text)
aws autoscaling set-desired-capacity --region ap-south-1 --auto-scaling-group-name "$ASG" --desired-capacity 0   # stop
aws autoscaling set-desired-capacity --region ap-south-1 --auto-scaling-group-name "$ASG" --desired-capacity 1   # start (~3–4 min cold start)
```

### Backups

Neon provides continuous backups + point-in-time restore — restore from the Neon
console (PITR / branch-from-timestamp). There is no self-managed backup service.

### Ongoing cost (always-on)

| Resource | ~Monthly |
|---|---|
| EC2 `t4g.small` (ap-south-1) + 16 GB gp3 + IPv4 | ~$13 |
| Neon (free tier) | $0 |
| Cognito (50k MAU free) | $0 |
| Cloudflare Pages + Tunnel | $0 |
| **Total** | **~$13/mo** |

(Mumbai `t4g` is ~⅓ cheaper than us-east-1; the ~$3.65 of that is the public IPv4.
Scale-to-zero drops the EC2 + IPv4 line toward $0 when idle.)

### Teardown

```bash
CDK_DEFAULT_REGION=ap-south-1 pnpm exec cdk destroy ComputeStack
# Cognito (RETAIN policy protects the user pool; --force to really delete):
CDK_DEFAULT_REGION=us-east-1 pnpm exec cdk destroy AuthStack -c googleClientId=x -c googleClientSecret=x
# Neon: delete the project from the Neon console.
# SSM: aws ssm delete-parameters --region ap-south-1 --names $(aws ssm get-parameters-by-path --region ap-south-1 --path /eventform --query 'Parameters[].Name' --output text)
```
