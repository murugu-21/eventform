# eventform

Multi-tenant form builder with webhook delivery, built on a transactional
outbox → Debezium CDC → Kafka → idempotent consumer pipeline.

> 🚧 Work in progress. Full architecture tour coming with the production
> deployment phase.

## Stack

React + shadcn/ui · NestJS · Postgres (RLS) · Drizzle · Debezium + Kafka ·
LocalStack KMS · AWS CDK + Cognito · docker-compose on EC2

## Local development

Prereqs: Node ≥ 22, pnpm, Docker.

```bash
pnpm install
pnpm build        # compile workspace packages (dist/ consumed by dependants)
cp .env.example .env
pnpm db:up        # postgres 16 (wal_level=logical) + localstack kms
pnpm db:migrate   # tables, roles, RLS policies
pnpm test         # unit + KMS/RLS integration tests
```

## Repo layout

- `packages/shared` — webhook HMAC utils, event schemas (zod), KMS secret cipher
- `packages/db` — Drizzle schema, migrations, tenant-scoped tx helper
- `apps/api` — NestJS REST API — auth, forms, endpoints, public submission, deliveries
- `apps/worker` — Kafka consumer + webhook delivery — idempotent, at-least-once, auto-retry
- `apps/web` — React frontend *(phase 4)*
- `infra` — docker-compose + AWS CDK *(phase 5)*

## Run the pipeline locally

After completing the base setup in **Local development** above:

```bash
pnpm build
pnpm db:up        # starts postgres + localstack + kafka + kafka-connect
pnpm db:migrate
pnpm connect:register   # idempotent PUT of the Debezium outbox connector
```

Then in two separate terminals:

```bash
# terminal 1
PORT=3001 node apps/api/dist/main.js

# terminal 2
node apps/worker/dist/main.js
```

Dev-mode auth uses a bearer token of the form `Bearer dev_<sub>-<anything>` — the
sub prefix is used as a stable tenant identifier (e.g. `Bearer dev_alice-1`).
Submit a form anonymously via `POST /f/<slug>` and the worker will deliver a
HMAC-signed webhook to every active endpoint within a few seconds.

## Design docs

- [Design spec](docs/superpowers/specs/2026-06-11-eventform-design.md)
- [Phase 1 plan](docs/superpowers/plans/2026-06-11-eventform-phase-1-foundation.md)
- [Phase 2a plan](docs/superpowers/plans/2026-06-11-eventform-phase-2a-api-core.md)
- [Phase 2b plan](docs/superpowers/plans/2026-06-11-eventform-phase-2b-public-outbox.md)
- [Phase 3 plan](docs/superpowers/plans/2026-06-11-eventform-phase-3-pipeline.md)
