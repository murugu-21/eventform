# eventform

Multi-tenant form builder with end-to-end webhook delivery, built to demonstrate
production-grade distributed-systems patterns: transactional outbox, CDC via
Debezium, idempotent Kafka consumer, row-level security, AES-256-GCM-encrypted
secrets, and Cognito PKCE auth — all runnable locally with a single `docker compose up`.

---

## Architecture

```mermaid
graph LR
    subgraph Browser
        SPA["React 19 SPA\n(PKCE auth)"]
    end

    subgraph Pages["Cloudflare Pages (CDN)"]
        Bundle["Static SPA bundle\n+ ApiHealthGate fallback"]
    end

    subgraph Tunnel["Cloudflare Tunnel (cloudflared)"]
        Ingress["eventform-api.* → api:3001\n(outbound-only, no open ports)"]
    end

    subgraph API["NestJS API (app_api role)"]
        Auth["CognitoTokenVerifier\n(jose JWKS)"]
        OutboxInsert["Transactional outbox\ninsert (same tx)"]
    end

    subgraph PostgreSQL["PostgreSQL 16 (logical replication)"]
        OutboxTable["outbox table"]
        RLS["RLS policies\n(tenant isolation)"]
    end

    subgraph Debezium["Debezium Connect (CDC)"]
        Connector["eventform-outbox\nconnector"]
    end

    subgraph Kafka["Redpanda (Kafka API)"]
        Topic["eventform.events"]
    end

    subgraph Worker["Worker (app_worker role)"]
        Consumer["Idempotent consumer\n(SKIP LOCKED)"]
        Retry["Retry scheduler\n(escalating backoff: 5s, 30s)"]
    end

    subgraph Webhook["Receiver"]
        HTTP["Webhook endpoint\n(HMAC-signed)"]
    end

    subgraph AWS["AWS (Cognito — free tier only)"]
        Cognito["Cognito UserPool\n(Google IdP)"]
    end

    Pages -->|"serves SPA bundle"| SPA
    SPA -->|"PKCE code flow"| Cognito
    SPA -->|"Bearer access token"| Ingress
    Ingress --> API
    API --> Auth
    Auth -->|"JWKS verify"| Cognito
    API -->|"AES-256-GCM encrypt\nendpoint secrets (in-process)"| OutboxInsert
    API --> OutboxInsert
    OutboxInsert --> OutboxTable
    OutboxTable --> Connector
    Connector --> Topic
    Topic --> Consumer
    Consumer -->|"HMAC-signed POST"| HTTP
    Consumer --> Retry
    RLS -.->|"tenant isolation"| OutboxTable
```

**Delivery guarantee:** at-least-once. Receivers deduplicate on `X-Eventform-Event-Id`
(stable per outbox row UUID). The consumer uses `SELECT ... FOR UPDATE SKIP LOCKED`
so multiple worker replicas never race on the same row.

---

## Patterns on display

| Pattern | Why it matters | Implementing file |
|---|---|---|
| **Transactional outbox** | Submission write and event emit are atomic — no dual-write, no missed events | [`apps/api/src/public/public.service.ts`](apps/api/src/public/public.service.ts) |
| **CDC (Debezium)** | Outbox rows flow to Kafka via the Postgres WAL — zero polling, no extra DB load | [`infra/compose/connect/eventform-outbox.json`](infra/compose/connect/eventform-outbox.json) |
| **Idempotent consumer** | Each event id is claimed in a `processed_events` ledger inside the work transaction; re-delivered messages hit the conflict and are skipped | [`apps/worker/src/processor/delivery-processor.service.ts`](apps/worker/src/processor/delivery-processor.service.ts) |
| **Row-level security** | Every query runs under a tenant-scoped transaction; no cross-tenant data leaks at the SQL layer | [`packages/db/migrations/0001_rls.sql`](packages/db/migrations/0001_rls.sql) |
| **SKIP LOCKED scheduler** | Retry rows are claimed with `SELECT ... FOR UPDATE SKIP LOCKED` — safe to run N replicas | [`apps/worker/src/scheduler/retry-scheduler.service.ts`](apps/worker/src/scheduler/retry-scheduler.service.ts) |
| **Manual retry (API)** | Operators can re-queue failed deliveries from the dashboard | [`apps/api/src/deliveries/deliveries.service.ts`](apps/api/src/deliveries/deliveries.service.ts) |
| **HMAC webhook signing** | Every delivery carries `X-Eventform-Signature`; receivers verify authenticity | [`packages/shared/src/hmac.ts`](packages/shared/src/hmac.ts) |
| **Encrypted secrets** | Endpoint HMAC secrets are AES-256-GCM encrypted at rest, in-process; the tenant id is bound in as AAD so a ciphertext can't be reused across tenants | [`packages/shared/src/cipher.ts`](packages/shared/src/cipher.ts) |
| **PKCE auth** | SPA uses authorization-code + PKCE flow against Cognito hosted UI — no client secret in the browser | [`apps/web/src/lib/pkce.ts`](apps/web/src/lib/pkce.ts) |
| **Cognito token verifier** | API verifies RS256 access tokens via remote JWKS; test seam accepts a local keypair (no AWS needed in CI) | [`apps/api/src/auth/cognito-token-verifier.ts`](apps/api/src/auth/cognito-token-verifier.ts) |

**Honest notes:**
- Delivery is **at-least-once, not exactly-once.** Webhook receivers should deduplicate
  on `X-Eventform-Event-Id` if they require idempotency.
- The Debezium connector uses the admin DB user in this demo (no dedicated replication
  role). A production hardening step would create a minimal-privilege replication role.
- **Secret-encryption threat model:** root of trust is `SECRET_ENC_KEY` (a 32-byte AES-256
  key) held in the environment and backed up out-of-band. A DB dump without the key is
  ciphertext-only, and the tenant id is bound in as GCM additional authenticated data, so a
  ciphertext lifted onto another tenant's row fails to decrypt. Losing the key orphans every
  stored endpoint secret — so back it up. (For an audited, rot-managed, HSM-backed key you'd
  swap the cipher's implementation for real AWS KMS behind the same `SecretCipher` seam.)

---

## Local quickstart

**Prerequisites:** Node >= 22, pnpm, Docker.

```bash
git clone https://github.com/murugu-21/eventform
cd eventform
pnpm install
pnpm build
cp .env.example .env

pnpm db:up            # postgres + redpanda (kafka api) + kafka-connect
pnpm db:migrate       # apply all Drizzle migrations (tables, roles, RLS)
pnpm connect:register # register the Debezium outbox connector

# Terminal 1 — API
PORT=3001 node apps/api/dist/main.js

# Terminal 2 — worker
node apps/worker/dist/main.js

# Terminal 3 — web dev server
pnpm --filter @eventform/web dev
# => http://localhost:5173
```

---

## Demo walkthrough

1. Go to [http://localhost:5173](http://localhost:5173) and click **Sign in**.
   Enter **any handle** (e.g. `alice`) — dev mode requires no password and no Cognito.

2. **Dashboard** → **New form** → enter a title → **Create**.

3. **Form builder** → **Add field** → set label to `Name` → **Save fields** → **Publish**.
   Copy the public `/forms/<slug>` URL shown in the publish confirmation.

4. **Endpoints** → **New endpoint** → name it, set the URL to any POST-accepting target
   (e.g. [webhook.site](https://webhook.site), or `nc -l 9099`) → **Create** → copy and
   save the `whsec_...` secret → close the dialog.

5. Open the `/forms/<slug>` URL in a new tab, fill in the **Name** field, click **Submit**.
   You should see "Response recorded."

6. Return to **Deliveries** — the row flips from `pending` to `delivered` within ~5 s.
   To demo failure + retry: delete the endpoint URL, submit again, watch the delivery
   fail, then restore the URL and click **Retry**.

---

## Test inventory

| Suite | Tests | What it covers |
|---|---|---|
| `packages/shared` | 30 | HMAC signing/verification, event schemas (Zod), AES-256-GCM cipher (in-process, no external deps) |
| `packages/db` | 12 | RLS policies (integration, real Postgres) |
| `apps/api` | 62 | e2e API routes (NestJS test app), Cognito JWT verifier (local JWKS keypair), zod pipe, exception filter |
| `apps/worker` | 22 | delivery processor, retry scheduler (SKIP LOCKED), backoff, pipeline e2e (real Kafka) |
| `apps/web` | 22 | PKCE helpers (RFC 7636 vectors), API client, Cognito callback |
| `infra/cdk` | 11 | AuthStack + CertStack + BackupStack CloudFormation template assertions (no AWS) |
| **Total** | **159** | unit + integration |
| **Playwright smoke** | 2 | full loop: sign in → build form → publish → anonymous submit → delivery delivered |

Run all unit/integration suites:
```bash
pnpm test
```

Run the Playwright smoke (requires API + worker + compose stack up):
```bash
pnpm --filter @eventform/web exec playwright test
```

---

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the step-by-step handoff checklist
(AWS/Cognito setup, VPS provisioning, first-time bootstrap, CI/CD secrets).

**Cost summary (running in production):**
- VPS (Hetzner CX22 or equivalent): ~€4–6/month
- AWS Cognito: $0 (50 000 MAU free tier)
- Secret encryption: $0 (in-process AES-256-GCM — no KMS, no extra service)
- Domain: already owned

---

## Repo layout

```
packages/shared   HMAC utils, Zod event schemas, AES-256-GCM secret cipher
packages/db       Drizzle schema, migrations, tenant-scoped tx helper
apps/api          NestJS REST API — auth, forms, endpoints, public submission, deliveries
apps/worker       Kafka consumer + webhook delivery — idempotent, at-least-once, auto-retry
apps/web          React 19 + shadcn/ui SPA — form builder, dashboard, Playwright smoke
infra/compose     docker-compose.yml (dev) + docker-compose.prod.yml (prod); cloudflared tunnel → api:3001
infra/cdk         AWS CDK: AuthStack (Cognito) + CertStack + BackupStack
infra/prod        bootstrap.sh — first-boot hardening
.github/workflows ci.yml (tests) + deploy.yml (GHCR images + VPS SSH deploy)
docs/DEPLOYMENT.md  Human handoff checklist
```

## Auth modes

| Mode | How it works | When to use |
|---|---|---|
| `AUTH_MODE=dev` | `Bearer dev_<sub>` tokens, no signature, sub extracted from header | Local development only |
| `AUTH_MODE=cognito` | RS256 access tokens verified via Cognito JWKS endpoint | Staging and production (pinned in prod compose) |

Prod compose hard-pins `AUTH_MODE=cognito` — dev tokens are impossible in production.
