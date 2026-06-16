# API Repository Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `apps/api` persistence behind repository ports (interfaces) + Drizzle adapters, so services depend on an abstraction instead of importing `drizzle-orm`/`pg` directly — with no behavior change.

**Architecture:** Per-module repository **port** (interface) + Drizzle **adapter**, wired by a DI token (mirroring `TOKEN_VERIFIER`/`SECRET_CIPHER`). Every repo method takes an **`Executor`** (a Drizzle handle) as its first arg; the **service** keeps owning the `withTenant` transaction and passes the tx-bound handle (atomic writes) or a pool-bound handle (anonymous reads). Services retain all business logic, HTTP exceptions, encryption, and payload building.

**Tech Stack:** NestJS, Drizzle ORM, `pg`, Postgres (RLS), Vitest (existing integration suite against live Postgres).

**Verification model:** This is a refactor under existing coverage. There are no new tests. After each task, the existing suites must stay green:
- `pnpm --filter @eventform/api test`
- `pnpm --filter @eventform/db test`

If a task makes a suite fail, the refactor for that module is wrong — fix before committing.

---

## File Structure

For each module under `apps/api/src/<module>/`:
- `*.repository.ts` — **port**: the interface, a DI token const, and the row type(s) re-exported from `@eventform/db`. No `drizzle-orm` import.
- `*.repository.drizzle.ts` — **adapter**: the only file importing `drizzle-orm` + schema tables for that module. `@Injectable()`.
- `*.service.ts` — **modified**: stops importing `drizzle-orm`/schema-tables; injects the port; keeps `withTenant`, exceptions, cipher, payloads.
- `*.module.ts` — **modified**: provides the port via `{ provide: TOKEN, useClass: Adapter }`.

Foundation (shared):
- `packages/db/src/client.ts` — add `Executor` type alias + `poolExecutor(pool)`.
- `packages/db/src/index.ts` — export them.

After completion, `drizzle-orm` and `pg` are imported **only** in `*.repository.drizzle.ts` files and `@eventform/db` — not in any `*.service.ts`.

---

## Task 1: Executor foundation in @eventform/db

**Files:**
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Add `Executor` alias and `poolExecutor` to client.ts**

Open `packages/db/src/client.ts`. It already has `export type Db = NodePgDatabase<typeof schema>;` and `withTenant`. Add, right after the `Db` type definition:

```ts
/**
 * A query executor handed to repositories. It is just a Drizzle handle:
 * - tx-bound (from withTenant) for atomic, tenant-scoped work, or
 * - pool-bound (from poolExecutor) for anonymous reads under RLS public policies.
 * Repositories never open their own connection; the caller chooses the executor.
 */
export type Executor = Db;

let pooled: Db | undefined;

/**
 * A pool-bound Drizzle handle for non-transactional / anonymous reads (no
 * `SET LOCAL app.tenant_id`). Memoized per process. Each query borrows a pool
 * connection. Do NOT use for multi-statement atomic work — use withTenant.
 */
export function poolExecutor(pool: Pool): Db {
  if (!pooled) {
    pooled = drizzle(pool, { schema });
  }
  return pooled;
}
```

`drizzle`, `schema`, and `Pool` are already imported in this file (used by `withTenant`). Confirm those imports exist; if `Pool` is only imported as a type, ensure `import { Pool } from "pg"` / the existing import covers the value use (it is already used as a parameter type in `withTenant`, so the import is present).

- [ ] **Step 2: Export from index.ts**

Open `packages/db/src/index.ts`. It re-exports from `./client`. Ensure `Executor` and `poolExecutor` are exported. If the file does `export * from "./client";`, no change is needed — verify with:

Run: `grep -nE "client|Executor|poolExecutor" packages/db/src/index.ts`
Expected: a re-export of `./client` is present (so the new symbols are exported). If it uses named exports instead of `export *`, add `Executor` (type) and `poolExecutor` to the list.

- [ ] **Step 3: Build the db package to typecheck**

Run: `pnpm --filter @eventform/db build`
Expected: PASS (no type errors).

- [ ] **Step 4: Run db tests (unchanged, must stay green)**

Run: `pnpm --filter @eventform/db test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/client.ts packages/db/src/index.ts
git commit -m "feat(db): add Executor type + poolExecutor for the repository layer"
```

---

## Task 2: EndpointRepository

**Files:**
- Create: `apps/api/src/endpoints/endpoints.repository.ts`
- Create: `apps/api/src/endpoints/endpoints.repository.drizzle.ts`
- Modify: `apps/api/src/endpoints/endpoints.service.ts`
- Modify: `apps/api/src/endpoints/endpoints.module.ts`

- [ ] **Step 1: Create the port** (`endpoints.repository.ts`)

```ts
import type { Executor } from "@eventform/db";
import { endpoints } from "@eventform/db";

export const ENDPOINT_REPOSITORY = "ENDPOINT_REPOSITORY";

export type EndpointRow = typeof endpoints.$inferSelect;

export interface EndpointRepository {
  countByTenant(x: Executor, tenantId: string): Promise<number>;
  insert(
    x: Executor,
    values: { tenantId: string; name: string; url: string; secretCiphertext: string },
  ): Promise<EndpointRow>;
  listByTenant(x: Executor): Promise<EndpointRow[]>;
  findById(x: Executor, id: string, tenantId: string): Promise<EndpointRow | undefined>;
  update(
    x: Executor,
    id: string,
    tenantId: string,
    patch: Partial<{ name: string; url: string; active: boolean }>,
  ): Promise<EndpointRow | undefined>;
  updateSecret(
    x: Executor,
    id: string,
    tenantId: string,
    secretCiphertext: string,
  ): Promise<EndpointRow | undefined>;
  remove(x: Executor, id: string, tenantId: string): Promise<EndpointRow | undefined>;
}
```

Note: `endpoints` is imported only to derive `EndpointRow` via `$inferSelect`; no `drizzle-orm` operators here.

- [ ] **Step 2: Create the adapter** (`endpoints.repository.drizzle.ts`)

```ts
import { Injectable } from "@nestjs/common";
import { and, asc, count, eq } from "drizzle-orm";
import { endpoints, type Executor } from "@eventform/db";
import { EndpointRepository, EndpointRow } from "./endpoints.repository";

@Injectable()
export class DrizzleEndpointRepository implements EndpointRepository {
  async countByTenant(x: Executor, tenantId: string): Promise<number> {
    const [{ value }] = await x
      .select({ value: count() })
      .from(endpoints)
      .where(eq(endpoints.tenantId, tenantId));
    return value;
  }

  async insert(
    x: Executor,
    values: { tenantId: string; name: string; url: string; secretCiphertext: string },
  ): Promise<EndpointRow> {
    const [created] = await x.insert(endpoints).values(values).returning();
    return created;
  }

  listByTenant(x: Executor): Promise<EndpointRow[]> {
    return x.select().from(endpoints).orderBy(asc(endpoints.createdAt));
  }

  async findById(x: Executor, id: string, tenantId: string): Promise<EndpointRow | undefined> {
    const [found] = await x
      .select()
      .from(endpoints)
      .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)));
    return found;
  }

  async update(
    x: Executor,
    id: string,
    tenantId: string,
    patch: Partial<{ name: string; url: string; active: boolean }>,
  ): Promise<EndpointRow | undefined> {
    const [updated] = await x
      .update(endpoints)
      .set(patch)
      .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)))
      .returning();
    return updated;
  }

  async updateSecret(
    x: Executor,
    id: string,
    tenantId: string,
    secretCiphertext: string,
  ): Promise<EndpointRow | undefined> {
    const [updated] = await x
      .update(endpoints)
      .set({ secretCiphertext })
      .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)))
      .returning();
    return updated;
  }

  async remove(x: Executor, id: string, tenantId: string): Promise<EndpointRow | undefined> {
    const [removed] = await x
      .delete(endpoints)
      .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)))
      .returning();
    return removed;
  }
}
```

- [ ] **Step 3: Rewrite the service** (`endpoints.service.ts`) — full replacement

```ts
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { generateEndpointSecret, SecretCipher } from "@eventform/shared";
import { API_POOL, SECRET_CIPHER } from "../db/db.module";
import { CreateEndpointDto, UpdateEndpointDto } from "./endpoints.schemas";
import { ENDPOINT_REPOSITORY, EndpointRepository, EndpointRow } from "./endpoints.repository";

function publicView(row: EndpointRow) {
  const { secretCiphertext: _omitted, ...rest } = row;
  return rest;
}

@Injectable()
export class EndpointsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
    @Inject(ENDPOINT_REPOSITORY) private readonly repo: EndpointRepository,
  ) {}

  async create(tenantId: string, dto: CreateEndpointDto) {
    const secret = generateEndpointSecret();
    const secretCiphertext = await this.cipher.encrypt(secret, tenantId);
    const row = await withTenant(this.pool, tenantId, async (db) => {
      // Cap endpoints at 20 per tenant.
      const existing = await this.repo.countByTenant(db, tenantId);
      if (existing >= 20) {
        throw new ConflictException("endpoint limit reached (20)");
      }
      return this.repo.insert(db, { tenantId, name: dto.name, url: dto.url, secretCiphertext });
    });
    return { ...publicView(row), secret };
  }

  list(tenantId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const rows = await this.repo.listByTenant(db);
      return rows.map(publicView);
    });
  }

  async update(tenantId: string, id: string, dto: UpdateEndpointDto) {
    const row = await withTenant(this.pool, tenantId, (db) =>
      this.repo.update(db, id, tenantId, dto),
    );
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    return publicView(row);
  }

  async remove(tenantId: string, id: string) {
    const removed = await withTenant(this.pool, tenantId, (db) =>
      this.repo.remove(db, id, tenantId),
    );
    if (!removed) {
      throw new NotFoundException("endpoint not found");
    }
  }

  async revealSecret(tenantId: string, id: string) {
    const row = await withTenant(this.pool, tenantId, (db) =>
      this.repo.findById(db, id, tenantId),
    );
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    const secret = await this.cipher.decrypt(row.secretCiphertext, tenantId);
    return { secret };
  }

  async rotateSecret(tenantId: string, id: string) {
    const secret = generateEndpointSecret();
    const secretCiphertext = await this.cipher.encrypt(secret, tenantId);
    const row = await withTenant(this.pool, tenantId, (db) =>
      this.repo.updateSecret(db, id, tenantId, secretCiphertext),
    );
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    return { ...publicView(row), secret };
  }
}
```

Note: `update` passes `dto` (an `UpdateEndpointDto`) directly as the patch — same as the original `.set(dto)`.

- [ ] **Step 4: Provide the repo in the module** (`endpoints.module.ts`)

Add to the module's `providers` array (alongside the existing service):

```ts
import { ENDPOINT_REPOSITORY } from "./endpoints.repository";
import { DrizzleEndpointRepository } from "./endpoints.repository.drizzle";
// ...
providers: [
  EndpointsService,
  { provide: ENDPOINT_REPOSITORY, useClass: DrizzleEndpointRepository },
],
```

(Keep existing controller/exports as they are.)

- [ ] **Step 5: Run the API suite (must stay green)**

Run: `pnpm --filter @eventform/api test`
Expected: PASS — endpoints e2e tests behave identically.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/endpoints/
git commit -m "refactor(api): extract EndpointRepository port + Drizzle adapter"
```

---

## Task 3: SubmissionRepository

**Files:**
- Create: `apps/api/src/submissions/submissions.repository.ts`
- Create: `apps/api/src/submissions/submissions.repository.drizzle.ts`
- Modify: `apps/api/src/submissions/submissions.service.ts`
- Modify: `apps/api/src/submissions/submissions.module.ts`

- [ ] **Step 1: Create the port** (`submissions.repository.ts`)

```ts
import type { Executor } from "@eventform/db";
import { submissions } from "@eventform/db";

export const SUBMISSION_REPOSITORY = "SUBMISSION_REPOSITORY";

export type SubmissionRow = typeof submissions.$inferSelect;

export interface SubmissionListItem {
  id: string;
  formId: string;
  formTitle: string;
  answers: SubmissionRow["answers"];
  submittedAt: SubmissionRow["submittedAt"];
  sourceIp: SubmissionRow["sourceIp"];
}

export interface SubmissionRepository {
  /** All responses across the tenant's forms, newest first (latest 200). */
  listAll(x: Executor): Promise<SubmissionListItem[]>;
  /** Returns undefined if the form doesn't exist (under the current tenant/RLS). */
  formExists(x: Executor, formId: string): Promise<boolean>;
  listForForm(x: Executor, formId: string): Promise<SubmissionRow[]>;
}
```

- [ ] **Step 2: Create the adapter** (`submissions.repository.drizzle.ts`)

```ts
import { Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { forms, submissions, type Executor } from "@eventform/db";
import {
  SubmissionListItem,
  SubmissionRepository,
  SubmissionRow,
} from "./submissions.repository";

@Injectable()
export class DrizzleSubmissionRepository implements SubmissionRepository {
  listAll(x: Executor): Promise<SubmissionListItem[]> {
    return x
      .select({
        id: submissions.id,
        formId: submissions.formId,
        formTitle: forms.title,
        answers: submissions.answers,
        submittedAt: submissions.submittedAt,
        sourceIp: submissions.sourceIp,
      })
      .from(submissions)
      .innerJoin(forms, eq(forms.id, submissions.formId))
      .orderBy(desc(submissions.submittedAt))
      .limit(200);
  }

  async formExists(x: Executor, formId: string): Promise<boolean> {
    const [form] = await x.select({ id: forms.id }).from(forms).where(eq(forms.id, formId));
    return Boolean(form);
  }

  listForForm(x: Executor, formId: string): Promise<SubmissionRow[]> {
    return x
      .select()
      .from(submissions)
      .where(eq(submissions.formId, formId))
      .orderBy(desc(submissions.submittedAt));
  }
}
```

- [ ] **Step 3: Rewrite the service** (`submissions.service.ts`) — full replacement

```ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { SUBMISSION_REPOSITORY, SubmissionRepository } from "./submissions.repository";

@Injectable()
export class SubmissionsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(SUBMISSION_REPOSITORY) private readonly repo: SubmissionRepository,
  ) {}

  /** All responses across the tenant's forms, newest first (latest 200). */
  listAll(tenantId: string) {
    return withTenant(this.pool, tenantId, (db) => this.repo.listAll(db));
  }

  listForForm(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      if (!(await this.repo.formExists(db, formId))) {
        throw new NotFoundException("form not found");
      }
      return this.repo.listForForm(db, formId);
    });
  }
}
```

- [ ] **Step 4: Provide the repo in the module** (`submissions.module.ts`)

```ts
import { SUBMISSION_REPOSITORY } from "./submissions.repository";
import { DrizzleSubmissionRepository } from "./submissions.repository.drizzle";
// ...
providers: [
  SubmissionsService,
  { provide: SUBMISSION_REPOSITORY, useClass: DrizzleSubmissionRepository },
],
```

- [ ] **Step 5: Run the API suite**

Run: `pnpm --filter @eventform/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/submissions/
git commit -m "refactor(api): extract SubmissionRepository port + Drizzle adapter"
```

---

## Task 4: DeliveryRepository

**Files:**
- Create: `apps/api/src/deliveries/deliveries.repository.ts`
- Create: `apps/api/src/deliveries/deliveries.repository.drizzle.ts`
- Modify: `apps/api/src/deliveries/deliveries.service.ts`
- Modify: `apps/api/src/deliveries/deliveries.module.ts`

Note: the manual-retry path writes an `outbox` row **and** updates the delivery in one transaction. The OutboxRepository (Task 6) doesn't exist yet at this point, so this task keeps the outbox insert inside the DeliveryRepository for now via a dedicated `reEmitRetry` method that does both writes on the same executor. Task 6 does NOT need to revisit this (the outbox write stays co-located with the delivery update because they are one atomic unit owned by the deliveries use-case).

- [ ] **Step 1: Create the port** (`deliveries.repository.ts`)

```ts
import type { Executor } from "@eventform/db";
import { deliveries, deliveryAttempts } from "@eventform/db";
import type { ListDeliveriesQuery } from "./deliveries.schemas";

export const DELIVERY_REPOSITORY = "DELIVERY_REPOSITORY";

export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;

export interface DeliveryListItem {
  id: string;
  endpointId: string;
  endpointName: string;
  payload: DeliveryRow["payload"];
  status: DeliveryRow["status"];
  attemptCount: DeliveryRow["attemptCount"];
  nextRetryAt: DeliveryRow["nextRetryAt"];
  lastError: DeliveryRow["lastError"];
  responseCode: DeliveryRow["responseCode"];
  deliveredAt: DeliveryRow["deliveredAt"];
  createdAt: DeliveryRow["createdAt"];
}

export interface DeliveryRepository {
  list(x: Executor, tenantId: string, query: ListDeliveriesQuery): Promise<DeliveryListItem[]>;
  findById(x: Executor, id: string): Promise<DeliveryRow | undefined>;
  listAttempts(x: Executor, deliveryId: string): Promise<DeliveryAttemptRow[]>;
  /** SELECT ... FOR UPDATE — used to lock the row before a manual retry. */
  findByIdForUpdate(x: Executor, id: string): Promise<DeliveryRow | undefined>;
  /**
   * Manual retry, one atomic unit: insert a fresh outbox row from the stored
   * payload and reset the delivery to pending. Both writes run on `x`.
   */
  reEmitRetry(
    x: Executor,
    args: { delivery: DeliveryRow; tenantId: string; eventId: string; payload: DeliveryRow["payload"] },
  ): Promise<DeliveryRow>;
}
```

- [ ] **Step 2: Create the adapter** (`deliveries.repository.drizzle.ts`)

```ts
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, SQL } from "drizzle-orm";
import { deliveries, deliveryAttempts, endpoints, outbox, type Executor } from "@eventform/db";
import type { ListDeliveriesQuery } from "./deliveries.schemas";
import {
  DeliveryAttemptRow,
  DeliveryListItem,
  DeliveryRepository,
  DeliveryRow,
} from "./deliveries.repository";

@Injectable()
export class DrizzleDeliveryRepository implements DeliveryRepository {
  list(x: Executor, tenantId: string, query: ListDeliveriesQuery): Promise<DeliveryListItem[]> {
    const conditions: SQL[] = [eq(deliveries.tenantId, tenantId)];
    if (query.status) {
      conditions.push(eq(deliveries.status, query.status));
    }
    if (query.endpointId) {
      conditions.push(eq(deliveries.endpointId, query.endpointId));
    }
    return x
      .select({
        id: deliveries.id,
        endpointId: deliveries.endpointId,
        endpointName: endpoints.name,
        payload: deliveries.payload,
        status: deliveries.status,
        attemptCount: deliveries.attemptCount,
        nextRetryAt: deliveries.nextRetryAt,
        lastError: deliveries.lastError,
        responseCode: deliveries.responseCode,
        deliveredAt: deliveries.deliveredAt,
        createdAt: deliveries.createdAt,
      })
      .from(deliveries)
      .innerJoin(endpoints, eq(endpoints.id, deliveries.endpointId))
      .where(and(...conditions))
      .orderBy(desc(deliveries.createdAt))
      .limit(200);
  }

  async findById(x: Executor, id: string): Promise<DeliveryRow | undefined> {
    const [delivery] = await x.select().from(deliveries).where(eq(deliveries.id, id));
    return delivery;
  }

  listAttempts(x: Executor, deliveryId: string): Promise<DeliveryAttemptRow[]> {
    return x
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, deliveryId))
      .orderBy(asc(deliveryAttempts.attemptNo));
  }

  async findByIdForUpdate(x: Executor, id: string): Promise<DeliveryRow | undefined> {
    const [delivery] = await x.select().from(deliveries).where(eq(deliveries.id, id)).for("update");
    return delivery;
  }

  async reEmitRetry(
    x: Executor,
    args: { delivery: DeliveryRow; tenantId: string; eventId: string; payload: DeliveryRow["payload"] },
  ): Promise<DeliveryRow> {
    const { delivery, tenantId, eventId, payload } = args;
    await x.insert(outbox).values({
      id: eventId,
      tenantId,
      aggregateType: "delivery",
      aggregateId: delivery.id,
      eventType: String((delivery.payload as Record<string, unknown>).type ?? "unknown"),
      payload,
    });
    const [updated] = await x
      .update(deliveries)
      .set({
        status: "pending",
        attemptCount: 0,
        payload,
        eventId,
        nextRetryAt: null,
        lastError: null,
        responseCode: null,
      })
      .where(eq(deliveries.id, delivery.id))
      .returning();
    return updated;
  }
}
```

- [ ] **Step 3: Rewrite the service** (`deliveries.service.ts`) — full replacement

```ts
import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { ListDeliveriesQuery } from "./deliveries.schemas";
import { DELIVERY_REPOSITORY, DeliveryRepository } from "./deliveries.repository";

@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(DELIVERY_REPOSITORY) private readonly repo: DeliveryRepository,
  ) {}

  list(tenantId: string, query: ListDeliveriesQuery) {
    return withTenant(this.pool, tenantId, (db) => this.repo.list(db, tenantId, query));
  }

  getWithAttempts(tenantId: string, id: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const delivery = await this.repo.findById(db, id);
      if (!delivery) {
        throw new NotFoundException("delivery not found");
      }
      const attempts = await this.repo.listAttempts(db, id);
      return { ...delivery, attempts };
    });
  }

  /** Manual retry: failed-only, FOR UPDATE, reset budget, re-emit through the outbox. */
  retry(tenantId: string, id: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const delivery = await this.repo.findByIdForUpdate(db, id);
      if (!delivery) {
        throw new NotFoundException("delivery not found");
      }
      if (delivery.status !== "failed") {
        throw new ConflictException("only failed deliveries can be retried");
      }
      const eventId = randomUUID();
      const payload = { ...delivery.payload, eventId, attempt: 1 };
      return this.repo.reEmitRetry(db, { delivery, tenantId, eventId, payload });
    });
  }
}
```

- [ ] **Step 4: Provide the repo in the module** (`deliveries.module.ts`)

```ts
import { DELIVERY_REPOSITORY } from "./deliveries.repository";
import { DrizzleDeliveryRepository } from "./deliveries.repository.drizzle";
// ...
providers: [
  DeliveriesService,
  { provide: DELIVERY_REPOSITORY, useClass: DrizzleDeliveryRepository },
],
```

- [ ] **Step 5: Run the API suite**

Run: `pnpm --filter @eventform/api test`
Expected: PASS (retry e2e: failed → pending, new outbox row).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/deliveries/
git commit -m "refactor(api): extract DeliveryRepository port + Drizzle adapter"
```

---

## Task 5: FormRepository

**Files:**
- Create: `apps/api/src/forms/forms.repository.ts`
- Create: `apps/api/src/forms/forms.repository.drizzle.ts`
- Modify: `apps/api/src/forms/forms.service.ts`
- Modify: `apps/api/src/forms/forms.module.ts`

- [ ] **Step 1: Create the port** (`forms.repository.ts`)

```ts
import type { Executor } from "@eventform/db";
import { formFields, forms } from "@eventform/db";

export const FORM_REPOSITORY = "FORM_REPOSITORY";

export type FormRow = typeof forms.$inferSelect;
export type FormFieldRow = typeof formFields.$inferSelect;

export interface NewFormField {
  formId: string;
  tenantId: string;
  type: FormFieldRow["type"];
  label: string;
  options: string[] | null;
  required: boolean;
  position: number;
}

export interface FormRepository {
  insert(x: Executor, values: { tenantId: string; title: string; publicSlug: string }): Promise<FormRow>;
  listByTenant(x: Executor): Promise<FormRow[]>;
  findById(x: Executor, formId: string): Promise<FormRow | undefined>;
  findByIdForUpdate(x: Executor, formId: string): Promise<FormRow | undefined>;
  updateTitle(x: Executor, formId: string, title: string): Promise<FormRow | undefined>;
  setStatus(x: Executor, formId: string, status: FormRow["status"]): Promise<FormRow | undefined>;
  remove(x: Executor, formId: string): Promise<void>;
  listFields(x: Executor, formId: string): Promise<FormFieldRow[]>;
  deleteFields(x: Executor, formId: string): Promise<void>;
  insertFields(x: Executor, rows: NewFormField[]): Promise<FormFieldRow[]>;
}
```

- [ ] **Step 2: Create the adapter** (`forms.repository.drizzle.ts`)

```ts
import { Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { formFields, forms, type Executor } from "@eventform/db";
import { FormFieldRow, FormRepository, FormRow, NewFormField } from "./forms.repository";

@Injectable()
export class DrizzleFormRepository implements FormRepository {
  async insert(
    x: Executor,
    values: { tenantId: string; title: string; publicSlug: string },
  ): Promise<FormRow> {
    const [form] = await x.insert(forms).values(values).returning();
    return form;
  }

  listByTenant(x: Executor): Promise<FormRow[]> {
    return x.select().from(forms).orderBy(asc(forms.createdAt));
  }

  async findById(x: Executor, formId: string): Promise<FormRow | undefined> {
    const [form] = await x.select().from(forms).where(eq(forms.id, formId));
    return form;
  }

  async findByIdForUpdate(x: Executor, formId: string): Promise<FormRow | undefined> {
    const [form] = await x.select().from(forms).where(eq(forms.id, formId)).for("update");
    return form;
  }

  async updateTitle(x: Executor, formId: string, title: string): Promise<FormRow | undefined> {
    const [form] = await x.update(forms).set({ title }).where(eq(forms.id, formId)).returning();
    return form;
  }

  async setStatus(
    x: Executor,
    formId: string,
    status: FormRow["status"],
  ): Promise<FormRow | undefined> {
    const [form] = await x.update(forms).set({ status }).where(eq(forms.id, formId)).returning();
    return form;
  }

  async remove(x: Executor, formId: string): Promise<void> {
    await x.delete(forms).where(eq(forms.id, formId)); // fields cascade
  }

  listFields(x: Executor, formId: string): Promise<FormFieldRow[]> {
    return x
      .select()
      .from(formFields)
      .where(eq(formFields.formId, formId))
      .orderBy(asc(formFields.position));
  }

  async deleteFields(x: Executor, formId: string): Promise<void> {
    await x.delete(formFields).where(eq(formFields.formId, formId));
  }

  insertFields(x: Executor, rows: NewFormField[]): Promise<FormFieldRow[]> {
    return x.insert(formFields).values(rows).returning();
  }
}
```

Note: `publish` reads fields without the `position` ordering in the original (`db.select().from(formFields).where(...)` with no orderBy). Reusing `listFields` (which adds an ORDER BY) is behavior-equivalent for the `fields.length === 0` check — the order is irrelevant to a count. Acceptable.

- [ ] **Step 3: Rewrite the service** (`forms.service.ts`) — full replacement

```ts
import { randomBytes } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { CreateFormDto, ReplaceFieldsDto } from "./forms.schemas";
import { FORM_REPOSITORY, FormRepository } from "./forms.repository";

@Injectable()
export class FormsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(FORM_REPOSITORY) private readonly repo: FormRepository,
  ) {}

  create(tenantId: string, dto: CreateFormDto) {
    return withTenant(this.pool, tenantId, (db) =>
      this.repo.insert(db, {
        tenantId,
        title: dto.title,
        publicSlug: randomBytes(6).toString("base64url"),
      }),
    );
  }

  list(tenantId: string) {
    return withTenant(this.pool, tenantId, (db) => this.repo.listByTenant(db));
  }

  async getWithFields(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.findById(db, formId);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      const fields = await this.repo.listFields(db, formId);
      return { ...form, fields };
    });
  }

  async updateTitle(tenantId: string, formId: string, dto: CreateFormDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.updateTitle(db, formId, dto.title);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      return form;
    });
  }

  async remove(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.findByIdForUpdate(db, formId);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("published forms cannot be deleted");
      }
      await this.repo.remove(db, formId);
    });
  }

  async replaceFields(tenantId: string, formId: string, dto: ReplaceFieldsDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.findByIdForUpdate(db, formId);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("published forms cannot be edited");
      }
      await this.repo.deleteFields(db, formId);
      return this.repo.insertFields(
        db,
        dto.fields.map((f, position) => ({
          formId,
          tenantId,
          type: f.type,
          label: f.label,
          options: f.options ?? null,
          required: f.required,
          position,
        })),
      );
    });
  }

  async publish(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.findByIdForUpdate(db, formId);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("form is already published");
      }
      const fields = await this.repo.listFields(db, formId);
      if (fields.length === 0) {
        throw new ConflictException("cannot publish a form without fields");
      }
      const updated = await this.repo.setStatus(db, formId, "published");
      return updated;
    });
  }
}
```

- [ ] **Step 4: Provide the repo in the module** (`forms.module.ts`)

```ts
import { FORM_REPOSITORY } from "./forms.repository";
import { DrizzleFormRepository } from "./forms.repository.drizzle";
// ...
providers: [
  FormsService,
  { provide: FORM_REPOSITORY, useClass: DrizzleFormRepository },
],
```

- [ ] **Step 5: Run the API suite**

Run: `pnpm --filter @eventform/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/forms/
git commit -m "refactor(api): extract FormRepository port + Drizzle adapter"
```

---

## Task 6: Public path — FormRepository (anonymous read) + OutboxRepository, the atomic write

**Files:**
- Create: `apps/api/src/public/public.repository.ts`
- Create: `apps/api/src/public/public.repository.drizzle.ts`
- Modify: `apps/api/src/public/public.service.ts`
- Modify: `apps/api/src/public/public.module.ts`

This task carries the two riskiest pieces: the **anonymous published-form read** (pool executor, no tenant set, RLS public policy) and the **atomic submit write** (submission + deliveries + outbox under one `withTenant`). Run tests with extra care.

- [ ] **Step 1: Create the port** (`public.repository.ts`)

```ts
import type { Executor } from "@eventform/db";
import type { SubmissionReceivedEvent } from "@eventform/shared";

export const PUBLIC_REPOSITORY = "PUBLIC_REPOSITORY";

export interface PublicFormRecord {
  id: string;
  tenantId: string;
  title: string;
  slug: string;
  fields: {
    id: string;
    type: "text" | "multiple_choice";
    label: string;
    options: string[] | null;
    required: boolean;
    position: number;
  }[];
}

export interface DeliveryWrite {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  payload: SubmissionReceivedEvent;
}

export interface PublicRepository {
  /**
   * Anonymous read: runs on a POOL executor (no tenant set) so the RLS
   * public-read policies scope to published forms. Returns null if not found.
   */
  findPublishedFormBySlug(x: Executor, slug: string): Promise<PublicFormRecord | null>;
  /** Active endpoints for the tenant — used to fan out deliveries. */
  listActiveEndpointIds(x: Executor, tenantId: string): Promise<string[]>;
  /** Insert the submission and return its id. */
  insertSubmission(
    x: Executor,
    row: { formId: string; tenantId: string; answers: Record<string, string>; sourceIp: string | undefined; submittedAt: Date },
  ): Promise<string>;
  /** Insert one delivery + its outbox row (called once per active endpoint, same tx). */
  insertDeliveryWithOutbox(x: Executor, tenantId: string, write: DeliveryWrite): Promise<void>;
}
```

- [ ] **Step 2: Create the adapter** (`public.repository.drizzle.ts`)

```ts
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { deliveries, endpoints, outbox, submissions, type Executor } from "@eventform/db";
import { DeliveryWrite, PublicFormRecord, PublicRepository } from "./public.repository";

@Injectable()
export class DrizzlePublicRepository implements PublicRepository {
  async findPublishedFormBySlug(x: Executor, slug: string): Promise<PublicFormRecord | null> {
    // Raw SQL preserves the exact anonymous read the service used (RLS public
    // policies apply because no app.tenant_id is set on a pool executor).
    const session = x.$client; // node-postgres Pool/Client behind the Drizzle handle
    const form = await session.query(
      `SELECT id, tenant_id, title, public_slug FROM forms WHERE public_slug = $1`,
      [slug],
    );
    if (form.rowCount !== 1) {
      return null;
    }
    const fields = await session.query(
      `SELECT id, type, label, options, required, position
       FROM form_fields WHERE form_id = $1 ORDER BY position`,
      [form.rows[0].id],
    );
    return {
      id: form.rows[0].id,
      tenantId: form.rows[0].tenant_id,
      title: form.rows[0].title,
      slug: form.rows[0].public_slug,
      fields: fields.rows,
    };
  }

  async listActiveEndpointIds(x: Executor, tenantId: string): Promise<string[]> {
    const rows = await x
      .select({ id: endpoints.id })
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.active, true)));
    return rows.map((r) => r.id);
  }

  async insertSubmission(
    x: Executor,
    row: { formId: string; tenantId: string; answers: Record<string, string>; sourceIp: string | undefined; submittedAt: Date },
  ): Promise<string> {
    const [submission] = await x.insert(submissions).values(row).returning();
    return submission.id;
  }

  async insertDeliveryWithOutbox(x: Executor, tenantId: string, write: DeliveryWrite): Promise<void> {
    await x.insert(deliveries).values({
      id: write.deliveryId,
      tenantId,
      endpointId: write.endpointId,
      payload: write.payload,
      eventId: write.eventId,
    });
    await x.insert(outbox).values({
      id: write.eventId,
      tenantId,
      aggregateType: "delivery",
      aggregateId: write.deliveryId,
      eventType: "submission.received",
      payload: write.payload,
    });
  }
}
```

Note on `x.$client`: Drizzle's node-postgres handle exposes the underlying pool/client as `$client`. For the anonymous read we want raw SQL on the pool (exactly as the original service did). Pass the pool-bound executor from `poolExecutor(pool)`; `$client` is then the `Pool`. If `$client` typing is awkward, the service may instead inject `API_POOL` and pass the `Pool` directly to a `findPublishedFormBySlug(pool, slug)` overload — but prefer `$client` to keep the port uniform on `Executor`. Verify `x.$client.query` exists at build time (Step 4); if not, fall back to injecting `API_POOL` into the adapter and using it for this one method.

- [ ] **Step 3: Rewrite the service** (`public.service.ts`) — full replacement

```ts
import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { poolExecutor, withTenant } from "@eventform/db";
import type { SubmissionReceivedEvent } from "@eventform/shared";
import { API_POOL } from "../db/db.module";
import { PUBLIC_REPOSITORY, PublicFormRecord, PublicRepository } from "./public.repository";

export interface PublicField {
  id: string;
  type: "text" | "multiple_choice";
  label: string;
  options: string[] | null;
  required: boolean;
  position: number;
}

export interface PublicForm {
  id: string;
  title: string;
  slug: string;
  fields: PublicField[];
}

export interface ResolvedForm extends PublicForm {
  tenantId: string;
}

@Injectable()
export class PublicService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(PUBLIC_REPOSITORY) private readonly repo: PublicRepository,
  ) {}

  /** Anonymous read — RLS public-read policies scope to published forms. */
  async resolvePublishedForm(slug: string): Promise<ResolvedForm> {
    const record = await this.repo.findPublishedFormBySlug(poolExecutor(this.pool), slug);
    if (!record) {
      throw new NotFoundException("form not found");
    }
    return record as PublicFormRecord & ResolvedForm;
  }

  toPublicForm(resolved: ResolvedForm): PublicForm {
    const { tenantId: _omitted, ...pub } = resolved;
    return pub;
  }

  async submit(
    form: ResolvedForm,
    answers: Record<string, string>,
    sourceIp: string | undefined,
  ): Promise<{ submissionId: string }> {
    const submittedAt = new Date();
    return withTenant(this.pool, form.tenantId, async (db) => {
      const submissionId = await this.repo.insertSubmission(db, {
        formId: form.id,
        tenantId: form.tenantId,
        answers,
        sourceIp,
        submittedAt,
      });

      const endpointIds = await this.repo.listActiveEndpointIds(db, form.tenantId);
      for (const endpointId of endpointIds) {
        const deliveryId = randomUUID();
        const eventId = randomUUID();
        const payload: SubmissionReceivedEvent = {
          eventId,
          type: "submission.received",
          attempt: 1,
          tenantId: form.tenantId,
          formId: form.id,
          formTitle: form.title,
          submissionId,
          endpointId,
          deliveryId,
          answers,
          submittedAt: submittedAt.toISOString(),
        };
        await this.repo.insertDeliveryWithOutbox(db, form.tenantId, {
          deliveryId,
          endpointId,
          eventId,
          payload,
        });
      }
      return { submissionId };
    });
  }
}
```

Note: `resolvePublishedForm` returns the record; the `PublicFormRecord` shape already matches `ResolvedForm` (id/tenantId/title/slug/fields), so the cast is a no-op at runtime. Keep the `PublicField`/`PublicForm`/`ResolvedForm` interfaces in the service since the controller imports them.

- [ ] **Step 4: Provide the repo + build to check `$client`** (`public.module.ts`)

```ts
import { PUBLIC_REPOSITORY } from "./public.repository";
import { DrizzlePublicRepository } from "./public.repository.drizzle";
// ...
providers: [
  PublicService,
  { provide: PUBLIC_REPOSITORY, useClass: DrizzlePublicRepository },
],
```

Run: `pnpm --filter @eventform/api build`
Expected: PASS. If `x.$client.query` fails to typecheck, apply the fallback from Step 2's note (inject `API_POOL` into `DrizzlePublicRepository`, give `findPublishedFormBySlug` the pool from the field instead of `x.$client`), then rebuild.

- [ ] **Step 5: Run the API suite (atomic write + anonymous read are covered here)**

Run: `pnpm --filter @eventform/api test`
Expected: PASS — public submit fans out deliveries+outbox atomically; anonymous form fetch still works; the outbox-rollback test (revoking INSERT on outbox rolls back the whole submission) still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/public/
git commit -m "refactor(api): extract PublicRepository (anonymous read + atomic outbox write)"
```

---

## Task 7: TenantRepository

**Files:**
- Create: `apps/api/src/auth/tenants.repository.ts`
- Create: `apps/api/src/auth/tenants.repository.drizzle.ts`
- Modify: `apps/api/src/auth/tenants.service.ts`
- Modify: `apps/api/src/auth/auth.module.ts`

- [ ] **Step 1: Create the port** (`tenants.repository.ts`)

```ts
import type { Executor } from "@eventform/db";

export const TENANT_REPOSITORY = "TENANT_REPOSITORY";

export interface Tenant {
  id: string;
  name: string;
}

export interface TenantRepository {
  findBySub(x: Executor, sub: string): Promise<Tenant | undefined>;
  /** INSERT ... ON CONFLICT DO UPDATE — race-safe first-login provisioning. */
  insertBySub(x: Executor, sub: string): Promise<Tenant>;
  updateName(x: Executor, tenantId: string, name: string): Promise<Tenant>;
}
```

- [ ] **Step 2: Create the adapter** (`tenants.repository.drizzle.ts`)

Tenant provisioning runs on the pool (no tenant context — it's pre-tenant), so the adapter uses raw SQL via `x.$client` to match today's behavior exactly.

```ts
import { Injectable } from "@nestjs/common";
import type { Executor } from "@eventform/db";
import { Tenant, TenantRepository } from "./tenants.repository";

@Injectable()
export class DrizzleTenantRepository implements TenantRepository {
  async findBySub(x: Executor, sub: string): Promise<Tenant | undefined> {
    const res = await x.$client.query("SELECT id, name FROM tenants WHERE cognito_sub = $1", [sub]);
    return res.rowCount === 1 ? (res.rows[0] as Tenant) : undefined;
  }

  async insertBySub(x: Executor, sub: string): Promise<Tenant> {
    const res = await x.$client.query(
      `INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2)
       ON CONFLICT (cognito_sub) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub
       RETURNING id, name`,
      [sub, sub],
    );
    return res.rows[0] as Tenant;
  }

  async updateName(x: Executor, tenantId: string, name: string): Promise<Tenant> {
    const res = await x.$client.query(
      "UPDATE tenants SET name = $2 WHERE id = $1 RETURNING id, name",
      [tenantId, name],
    );
    return res.rows[0] as Tenant;
  }
}
```

- [ ] **Step 3: Rewrite the service** (`tenants.service.ts`) — full replacement

```ts
import { Inject, Injectable } from "@nestjs/common";
import { Pool } from "pg";
import { poolExecutor } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { TENANT_REPOSITORY, Tenant, TenantRepository } from "./tenants.repository";

export type { Tenant } from "./tenants.repository";

@Injectable()
export class TenantsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(TENANT_REPOSITORY) private readonly repo: TenantRepository,
  ) {}

  async findOrCreateBySub(sub: string): Promise<Tenant> {
    const x = poolExecutor(this.pool);
    const existing = await this.repo.findBySub(x, sub);
    if (existing) {
      return existing;
    }
    return this.repo.insertBySub(x, sub);
  }

  /** Display-name update (e.g. from the Google ID token after first login). */
  async updateName(tenantId: string, name: string): Promise<Tenant> {
    return this.repo.updateName(poolExecutor(this.pool), tenantId, name);
  }
}
```

Note: the original `Tenant` interface lived in `tenants.service.ts`; it now lives in the port and is re-exported here so existing importers (e.g. `me.controller.ts`, `current-tenant.decorator.ts`) keep working. Verify importers resolve in Step 5.

- [ ] **Step 4: Provide the repo in the module** (`auth.module.ts`)

```ts
import { TENANT_REPOSITORY } from "./tenants.repository";
import { DrizzleTenantRepository } from "./tenants.repository.drizzle";
// ...
providers: [
  // ...existing (TenantsService, TOKEN_VERIFIER, guards)...
  { provide: TENANT_REPOSITORY, useClass: DrizzleTenantRepository },
],
```

- [ ] **Step 5: Run the API suite**

Run: `pnpm --filter @eventform/api test`
Expected: PASS (auth/me/tenant-provisioning e2e).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/
git commit -m "refactor(api): extract TenantRepository port + Drizzle adapter"
```

---

## Task 8: Final sweep — verify the boundary holds

**Files:** none (verification only).

- [ ] **Step 1: No service imports drizzle-orm or pg's Pool for queries**

Run: `grep -rnE "from \"drizzle-orm\"|drizzle\(" apps/api/src --include="*.service.ts"`
Expected: **no matches** (services no longer import drizzle-orm). `Pool` may still be imported in services that own `withTenant`/`poolExecutor` — that's expected (the service owns transaction policy). Drizzle imports should appear only in `*.repository.drizzle.ts`.

Run: `grep -rlnE "from \"drizzle-orm\"" apps/api/src`
Expected: only `*.repository.drizzle.ts` files.

- [ ] **Step 2: Full build + both suites**

Run: `pnpm --filter @eventform/db build && pnpm --filter @eventform/api build`
Expected: PASS.

Run: `pnpm --filter @eventform/db test && pnpm --filter @eventform/api test`
Expected: PASS (all green — no behavior change).

- [ ] **Step 3: Playwright smoke (end-to-end backstop)**

Bring up the stack per README local quickstart, then:
Run: `pnpm --filter @eventform/web exec playwright test`
Expected: PASS (sign-in → build → publish → submit → delivered).

- [ ] **Step 4: Commit (if the sweep required any fixes)**

```bash
git add -A
git commit -m "refactor(api): repository-layer boundary sweep"
```

---

## Self-Review Notes (author)

- **Spec coverage:** every spec component maps to a task — `endpoints`(T2), `submissions`(T3), `deliveries`(T4), `forms`(T5), `public`/outbox + anonymous read(T6), `tenants`(T7); the `Executor`/`poolExecutor` foundation(T1); the no-drizzle-in-services guardrail verified(T8). Both atomic paths (submit T6, manual-retry T4) covered.
- **Type consistency:** DI token names (`*_REPOSITORY`), row types (`$inferSelect` aliases), and `Executor` are used identically across port/adapter/service in each task.
- **Risk flagged inline:** `x.$client` for raw-SQL anonymous reads (T6/T7) has a typed fallback (inject `API_POOL`) if it doesn't typecheck.
