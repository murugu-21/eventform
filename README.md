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
cp .env.example .env
pnpm db:up        # postgres 16 (wal_level=logical) + localstack kms
pnpm db:migrate   # tables, roles, RLS policies
pnpm test         # unit + KMS/RLS integration tests
```

## Repo layout

- `packages/shared` — webhook HMAC utils, event schemas (zod), KMS secret cipher
- `packages/db` — Drizzle schema, migrations, tenant-scoped tx helper
- `apps/api` — NestJS REST API *(phase 2)*
- `apps/worker` — Kafka consumer + webhook sender *(phase 3)*
- `apps/web` — React frontend *(phase 4)*
- `infra` — docker-compose + AWS CDK *(phase 5)*

## Design docs

- [Design spec](docs/superpowers/specs/2026-06-11-eventform-design.md)
- [Phase 1 plan](docs/superpowers/plans/2026-06-11-eventform-phase-1-foundation.md)
