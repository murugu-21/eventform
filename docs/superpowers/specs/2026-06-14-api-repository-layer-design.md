# API Repository Layer — Design

**Date:** 2026-06-14
**Status:** Approved (design); implementation pending
**Scope:** `apps/api` only. Worker and a separate domain layer are explicitly out of scope (a later, separate effort).

## Context

Today the API's NestJS services (`forms`, `endpoints`, `submissions`, `deliveries`, `public`, `auth/tenants`) reach the database directly: they import `drizzle-orm` operators, the `@eventform/db` schema, and raw `pg` `Pool`/`PoolClient`. Business logic, persistence, and transaction handling are mixed in one layer.

This refactor extracts **persistence behind repository ports (interfaces) + Drizzle adapters**, so services depend on an abstraction instead of the ORM. It is a structural change only — no behavior changes.

## Goal & non-goals

**Goal:** Each API module exposes a repository **port** (interface) implemented by a Drizzle **adapter**. Services stop importing `drizzle-orm`/`pg` and instead depend on the port via DI (mirroring the existing `TOKEN_VERIFIER` / `SECRET_CIPHER` seams).

**Non-goals (deferred):**
- No framework-free domain entities / value objects. Services remain the application layer and keep their current logic.
- No mock-based unit tests. The existing live-Postgres integration suite is the safety net.
- No new top-level `infrastructure/` directory (fits better when the domain layer lands).
- No worker changes.

## Guardrails (must not regress)

1. **Atomicity:** the submit path writes `submission` + N `deliveries` + N `outbox` rows in **one** `withTenant` transaction. The **manual-retry path** is a second atomic write — it updates the delivery and inserts a new `outbox` row in one transaction. Splitting persistence across repositories must not split either transaction (both use the shared tx executor inside one `withTenant`).
2. **RLS tenant scoping:** tenant-scoped operations run inside `withTenant` (which issues `SET LOCAL app.tenant_id`); the anonymous public-form read runs on the pool with no tenant set (relying on the RLS public-read policy). Both behaviors preserved exactly.
3. **Tests green at every step:** the existing integration tests (`apps/api`, `packages/db`) must pass after each module is migrated.

## Architecture — the executor pattern

A repository method must be able to participate in a caller-controlled transaction, so **every repository method takes an `Executor` as its first argument**:

```ts
import type { Db } from "@eventform/db";
export type Executor = Db; // a Drizzle handle: tx-bound (inside withTenant) OR pool-bound

export interface SubmissionRepository {
  insert(x: Executor, row: NewSubmission): Promise<Submission>;
}
```

The **service** decides which executor to pass and owns the transaction policy:

- **Atomic writes** — the service opens the unit of work and passes the *tx-bound* handle to each repo call, so all writes share one transaction and one `SET LOCAL app.tenant_id`:
  ```ts
  await withTenant(pool, tenantId, async (db) => {
    const sub = await this.submissions.insert(db, ...);
    await this.deliveries.insert(db, ...);   // same tx
    await this.outbox.insert(db, ...);       // same tx
  });
  ```
- **Anonymous / non-tenant reads** — the service passes a **pool-bound** executor (no `SET LOCAL`), so RLS public-read policies apply as today.

Repositories therefore hold **zero** knowledge of tenancy or transaction policy — they only run queries against whatever executor they're handed. That policy lives in the service, where it already is.

**Supporting infra:** add a pool-bound executor helper alongside `withTenant` in `@eventform/db`, e.g. `poolExecutor(pool): Db` (a memoized `drizzle(pool, { schema })`). `withTenant`'s signature is unchanged.

**Rejected alternative:** tx-bound repository *instances* via a UnitOfWork factory (`uow.withTenant(tenantId, repos => ...)`). Cleaner call sites but more infrastructure; not worth it for a repository-only first pass. Revisit if/when the domain layer lands.

## Components — the repositories

One port + one Drizzle adapter per module, derived from the current service's queries:

| Repository | Responsibilities (method surface, indicative) |
|---|---|
| `FormRepository` | CRUD forms + form_fields; `findPublishedBySlug` (anonymous, pool executor); publish/unpublish |
| `EndpointRepository` | CRUD endpoints (stores/returns ciphertext only); list active by tenant |
| `SubmissionRepository` | `insert` |
| `DeliveryRepository` | list/get deliveries; read `delivery_attempts` for the UI; manual-retry reads/writes |
| `OutboxRepository` | `insert` (used by submit + manual retry) |
| `TenantRepository` | find/provision by `cognito_sub`; update display name |

Each port + adapter is named/derived directly from the queries the corresponding service runs today — no new query behavior.

## File layout & DI wiring

Per-module, mirroring existing patterns:

```
apps/api/src/<module>/<module>.repository.ts          # port interface + Executor re-export + a DI token const
apps/api/src/<module>/<module>.repository.drizzle.ts  # Drizzle adapter (the only file importing drizzle-orm/schema)
```

- DI token per repo (e.g. `export const FORM_REPOSITORY = "FORM_REPOSITORY"`), provided in the module with `useClass` the Drizzle adapter, exactly like `TOKEN_VERIFIER` (`auth.module.ts`) and `SECRET_CIPHER` (`db.module.ts`).
- The pool-bound executor + `API_POOL` are provided by the existing `DbModule` (global) and injected into adapters that need anonymous reads.
- After the refactor, `drizzle-orm` and `pg` imports exist **only** in `*.repository.drizzle.ts` files and `@eventform/db` — not in any service.

## Data flow & responsibilities

```
Controller (driving adapter)
  → Service (application/use-case: input already validated by zod pipe;
             owns withTenant boundary; maps to HTTP exceptions; builds outbox payload; encrypts via SECRET_CIPHER)
    → Repository port
      → Drizzle adapter
        → Postgres
```

- Repos return plain row data or `null`; they do **not** throw HTTP exceptions.
- Services keep translating absence/conflict into `NotFoundException` / `ConflictException`, keep building the `SubmissionReceivedEvent` payload, and keep calling `SECRET_CIPHER` (repos persist/return ciphertext only — encryption never moves into persistence).

## Error handling

- `drizzle-exception.filter.ts` stays as-is (still catches DB constraint errors raised through the adapters).
- Service-level `NotFound`/`Conflict` mapping is unchanged.
- The `withTenant` rollback-on-error + poisoned-connection handling is unchanged (still the transaction owner's concern).

## Testing strategy

- No new unit tests, no mocks. The existing live-Postgres integration suites are the contract.
- Migrate one module at a time; run `pnpm --filter @eventform/api test` and `pnpm --filter @eventform/db test` after each. The whole suite green is the per-step success criterion.
- The Playwright smoke (sign-in → build → publish → submit → delivered) is the end-to-end backstop.

## Migration plan (incremental, tests green each step)

1. Add `poolExecutor(pool)` + `Executor` type to `@eventform/db`.
2. `endpoints` — simplest CRUD; establishes the port/adapter/DI shape.
3. `submissions` — single `insert`.
4. `deliveries` — lists + attempts + manual-retry.
5. `forms` — CRUD + fields + the anonymous `findPublishedBySlug` (exercises the pool executor).
6. `public` — the **atomic outbox write**; done last and most carefully (submission + deliveries + outbox via the tx executor inside `withTenant`).
7. `auth/tenants` (+ `me`) — provision/update.
8. Final sweep: confirm no service imports `drizzle-orm`/`pg`; full suite + smoke green.

## Out of scope / future

- **Domain layer** (entities, value objects, pure domain logic, application/use-case separation) — deferred; the user will decide based on the results of this pass.
- Worker repository/domain refactor.
- Any move to a top-level `infrastructure/` layout or a UnitOfWork factory — revisit alongside the domain layer.
