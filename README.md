# eventform

Multi-tenant form builder with webhook delivery, built on a transactional
outbox → Debezium CDC → Kafka → idempotent consumer pipeline.

## Stack

React 19 + shadcn/ui · NestJS · PostgreSQL 16 · Drizzle ORM · Debezium + Kafka ·
LocalStack KMS · AWS CDK + Cognito · docker-compose on EC2

## Local development

Prereqs: Node ≥ 22, pnpm, Docker.

```bash
pnpm install
pnpm build        # compile workspace packages (dist/ consumed by dependants)
cp .env.example .env
pnpm db:up        # postgres + localstack + kafka + kafka-connect
pnpm db:migrate   # tables, roles, RLS policies
pnpm test         # unit + KMS/RLS integration tests
```

## Repo layout

- `packages/shared` — webhook HMAC utils, event schemas (zod), KMS secret cipher
- `packages/db` — Drizzle schema, migrations, tenant-scoped tx helper
- `apps/api` — NestJS REST API — auth, forms, endpoints, public submission, deliveries
- `apps/worker` — Kafka consumer + webhook delivery — idempotent, at-least-once, auto-retry
- `apps/web` — React 19 + shadcn/ui SPA — form builder, dashboard, deliveries dashboard, Playwright smoke
- `infra` — docker-compose + AWS CDK *(phase 5)*

## Run the full demo locally

**Prerequisites:** Node ≥ 22, pnpm, Docker.

### 1. Start the compose stack

```bash
pnpm db:up          # postgres + localstack + kafka + kafka-connect (waits for healthy)
pnpm db:migrate     # apply all Drizzle migrations
pnpm connect:register   # register (or update) the Debezium outbox connector
```

Verify the connector is RUNNING:

```bash
curl http://localhost:8083/connectors/eventform-outbox/status
# → {"connector":{"state":"RUNNING",...},"tasks":[{"state":"RUNNING",...}]}
```

### 2. Build and start the API + worker

```bash
pnpm build   # compiles all workspace packages

# Terminal 1 — API
PORT=3001 node apps/api/dist/main.js

# Terminal 2 — Worker
node apps/worker/dist/main.js
```

### 3. Start the web dev server

```bash
pnpm --filter @eventform/web dev
# → http://localhost:5173
```

### 4. Sign in and try it

Navigate to [http://localhost:5173](http://localhost:5173) and click **Sign in**.
Enter **any handle** (e.g. `alice`) — dev mode stores the sub in localStorage and
sends `Bearer dev_<handle>` to the API (no password, no Cognito in Phase 4).

**Demo flow:**
1. **Dashboard** → New form → fill title → Create
2. **Form builder** → Add field (type: Text, label: "Name") → Save fields → Publish
3. Copy the public `/f/<slug>` link
4. **Endpoints** → New endpoint → point at any URL that accepts POST (e.g. a
   [webhook.site](https://webhook.site) URL or a local echo server) → store the secret
5. Open the public form link in a private window → fill in → Submit
6. **Deliveries** — the row should flip from `pending` → `delivered` within ~5 seconds
   (auto-polls every 5s); failed deliveries can be retried manually

Dev-mode auth uses bearer tokens of the form `Bearer dev_<sub>` — Phase 5 replaces
this with Cognito hosted-UI tokens without touching any page code.

## Design docs

- [Design spec](docs/superpowers/specs/2026-06-11-eventform-design.md)
- [Phase 1 plan](docs/superpowers/plans/2026-06-11-eventform-phase-1-foundation.md)
- [Phase 2a plan](docs/superpowers/plans/2026-06-11-eventform-phase-2a-api-core.md)
- [Phase 2b plan](docs/superpowers/plans/2026-06-11-eventform-phase-2b-public-outbox.md)
- [Phase 3 plan](docs/superpowers/plans/2026-06-11-eventform-phase-3-pipeline.md)
- [Phase 4 plan](docs/superpowers/plans/2026-06-11-eventform-phase-4-frontend.md)
