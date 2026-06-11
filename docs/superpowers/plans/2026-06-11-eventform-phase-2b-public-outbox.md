# Eventform Phase 2b — Public Submission, Outbox & Deliveries API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The event-producing half of the pipeline: anonymous public form pages, rate-limited submission that atomically writes submission + deliveries + outbox rows in ONE transaction (the dual-write fix), submissions listing, and the deliveries API with manual retry that re-enters the pipeline via a fresh outbox row.

**Architecture:** A `@Public()` controller serves `GET/POST /f/:slug` — the GET reads via the anonymous RLS policies (published forms only), the POST validates answers against the form definition then runs `withTenant(form.tenantId)` for the atomic insert (app-generated UUIDs let the outbox payload embed its own event/delivery ids). Deliveries are tenant-scoped reads plus a `FOR UPDATE`-locked retry that resets the attempt budget and emits a new `submission.received` outbox event (attempt 1, new event id). A global exception filter maps Drizzle-wrapped pg errors (23503→409, 23505→409) and keeps SQL/params out of responses and logs. Branch: `feat/phase-2-api`.

**Tech Stack:** as Phase 2a + `@nestjs/throttler` for per-IP rate limiting.

**Spec:** `docs/superpowers/specs/2026-06-11-eventform-design.md`
**Prereqs:** Phase 2a complete (72 tests green).

**Carried-forward review obligations (MUST land in this plan):**
1. `DELETE /endpoints/:id` with referencing deliveries → 409 (FK 23503 mapping) + e2e — from the 2a-6 review.
2. Global exception filter so `DrizzleQueryError` never echoes SQL/params/ciphertext into logs or responses — from the 2a-6 review.

---

## API surface in this plan

| Method/Path | Auth | Behavior |
|---|---|---|
| GET /f/:slug | public | published form + fields (render shape, no tenantId); 404 for draft/unknown |
| POST /f/:slug | public, throttled 10/min/IP | validate answers → atomic submission+deliveries+outbox; 201 `{submissionId}` |
| GET /forms/:id/submissions | bearer | newest-first submissions for own form |
| GET /deliveries | bearer | own deliveries, filter `?status=&endpointId=`, newest first, incl. endpointName |
| GET /deliveries/:id | bearer | delivery + ordered attempts |
| POST /deliveries/:id/retry | bearer | failed-only (409 otherwise); FOR UPDATE; reset budget; new outbox event |

Answer validation rules (keyed by field label — labels are unique per form since 2a):
required field missing/empty → 400; unknown answer key → 400; `multiple_choice` value must be one of options; `text` value ≤ 5000 chars; all values strings.

Retry semantics: allowed regardless of endpoint `active` (an explicit human action on an existing delivery); resets `attempt_count=0`, `status='pending'`, clears `next_retry_at`/`last_error`/`response_code`, sets `event_id` to the new outbox id; payload rebuilt from current form/submission/endpoint rows with `attempt: 1`.

## File structure

```
apps/api/src/
  drizzle-exception.filter.ts        global filter: 23503/23505 → 409, sanitized 500 otherwise
  public/public.module.ts
  public/public.controller.ts        @Public; GET/POST /f/:slug; @Throttle on POST
  public/public.service.ts           anonymous read; answer validation; atomic submit
  public/answers.ts                  validateAnswers(fields, answers) → string[] errors
  submissions/submissions.module.ts, submissions.controller.ts, submissions.service.ts
  deliveries/deliveries.module.ts, deliveries.controller.ts, deliveries.service.ts, deliveries.schemas.ts
apps/api/test/
  drizzle-exception.filter.test.ts
  public.e2e.test.ts
  submissions.e2e.test.ts
  deliveries.e2e.test.ts
  throttle.e2e.test.ts               own app instance (fresh throttler storage)
```

---

### Task 1: Drizzle exception filter (TDD)

**Files:**
- Create: `apps/api/src/drizzle-exception.filter.ts`
- Modify: `apps/api/src/app.module.ts` (APP_FILTER)
- Test: `apps/api/test/drizzle-exception.filter.test.ts`

- [ ] **Step 1: Write the failing unit test `apps/api/test/drizzle-exception.filter.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { DrizzleExceptionFilter } from "../src/drizzle-exception.filter";

function fakeHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: "/test", method: "POST" }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function drizzleError(pgCode: string): DrizzleQueryError {
  const cause = Object.assign(new Error("db says no"), { code: pgCode, constraint: "fk_x" });
  return new DrizzleQueryError("insert into secret_stuff ...", ["sensitive-param"], cause);
}

describe("DrizzleExceptionFilter", () => {
  it("maps foreign-key violations (23503) to 409", () => {
    const { host, status, json } = fakeHost();
    new DrizzleExceptionFilter().catch(drizzleError("23503"), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("secret_stuff");
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("sensitive-param");
  });

  it("maps unique violations (23505) to 409", () => {
    const { host, status } = fakeHost();
    new DrizzleExceptionFilter().catch(drizzleError("23505"), host);
    expect(status).toHaveBeenCalledWith(409);
  });

  it("maps anything else to a sanitized 500", () => {
    const { host, status, json } = fakeHost();
    new DrizzleExceptionFilter().catch(drizzleError("XX000"), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("secret_stuff");
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("sensitive-param");
  });
});
```

- [ ] **Step 2: Run → red** (`pnpm --filter @eventform/api test -- drizzle-exception`).

- [ ] **Step 3: Write `apps/api/src/drizzle-exception.filter.ts`**

```ts
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from "@nestjs/common";
import type { Response } from "express";
import { DrizzleQueryError } from "drizzle-orm/errors";

interface PgError {
  code?: string;
  constraint?: string;
}

const CONFLICT_CODES: Record<string, string> = {
  "23503": "resource is referenced by other records",
  "23505": "resource already exists",
};

/**
 * DrizzleQueryError.message embeds the SQL and params (which can include
 * KMS ciphertexts). This filter keeps that out of responses AND logs —
 * only the pg error code + constraint name are logged.
 */
@Catch(DrizzleQueryError)
export class DrizzleExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DrizzleExceptionFilter.name);

  catch(err: DrizzleQueryError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<{ url: string; method: string }>();
    const cause = (err.cause ?? {}) as PgError;
    const conflictMessage = cause.code ? CONFLICT_CODES[cause.code] : undefined;

    this.logger.warn(
      `${req.method} ${req.url} db error code=${cause.code ?? "?"} constraint=${cause.constraint ?? "?"}`,
    );

    if (conflictMessage) {
      res.status(409).json({ statusCode: 409, message: conflictMessage });
      return;
    }
    res.status(500).json({ statusCode: 500, message: "Internal server error" });
  }
}
```

- [ ] **Step 4: Register in `app.module.ts`**: add provider `{ provide: APP_FILTER, useClass: DrizzleExceptionFilter }` (import `APP_FILTER` from `@nestjs/core`).

- [ ] **Step 5: Run** `pnpm --filter @eventform/api test` → 35 green. Build clean.

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): add sanitizing drizzle exception filter with conflict mapping"`

---

### Task 2: Public form read — GET /f/:slug (TDD)

**Files:**
- Create: `apps/api/src/public/public.service.ts` (read part)
- Create: `apps/api/src/public/public.controller.ts` (GET part)
- Create: `apps/api/src/public/public.module.ts`
- Test: `apps/api/test/public.e2e.test.ts` (read tests)
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1a: Add the `publishForm` helper to `apps/api/test/utils.ts`**

NEVER import helpers from another `*.test.ts` file — vitest would re-register
that file's describe blocks in the importer and run its tests twice. Shared
helpers live in utils.ts. Append:

```ts
const PUBLISH_FIELDS = {
  fields: [
    { type: "text", label: "Your name", required: true },
    { type: "multiple_choice", label: "Rating", options: ["Good", "Bad"], required: false },
  ],
};

export async function publishForm(
  t: TestContext,
  sub: string,
  title = "Public form",
): Promise<{ id: string; publicSlug: string }> {
  const form = await t.http().post("/forms").set(t.authed(sub)).send({ title }).expect(201);
  await t.http().put(`/forms/${form.body.id}/fields`).set(t.authed(sub)).send(PUBLISH_FIELDS).expect(200);
  await t.http().post(`/forms/${form.body.id}/publish`).set(t.authed(sub)).expect(201);
  return form.body;
}
```

- [ ] **Step 1b: Write the failing e2e (read portion) `apps/api/test/public.e2e.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, publishForm, TestContext } from "./utils";

describe("public form read", () => {
  let t: TestContext;
  const sub = `pub-read-${randomUUID()}`;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.cleanupSubs([sub]);
    await t.close();
  });

  it("serves a published form anonymously without internal ids", async () => {
    const form = await publishForm(t, sub);
    const res = await t.http().get(`/f/${form.publicSlug}`).expect(200);
    expect(res.body.title).toBe("Public form");
    expect(res.body.fields).toHaveLength(2);
    expect(res.body.fields[0]).toMatchObject({ type: "text", label: "Your name", required: true });
    expect(res.body.fields[1].options).toEqual(["Good", "Bad"]);
    expect(res.body.tenantId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("tenant");
  });

  it("404s for drafts and unknown slugs", async () => {
    const draft = await t.http().post("/forms").set(t.authed(sub)).send({ title: "Draft" }).expect(201);
    await t.http().get(`/f/${draft.body.publicSlug}`).expect(404);
    await t.http().get("/f/does-not-exist").expect(404);
  });
});
```

- [ ] **Step 2: Run → red.**

- [ ] **Step 3: Write `apps/api/src/public/public.service.ts`** (read part; submit added in Task 3)

The anonymous read runs on a pool client with NO tenant GUC — the
`forms_public_read`/`form_fields_public_read` policies do the filtering.

```ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { API_POOL } from "../db/db.module";

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

/** Internal shape — includes tenantId for the submit path; never returned by controllers. */
export interface ResolvedForm extends PublicForm {
  tenantId: string;
}

@Injectable()
export class PublicService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  /** Anonymous read — RLS public-read policies scope to published forms. */
  async resolvePublishedForm(slug: string): Promise<ResolvedForm> {
    const form = await this.pool.query(
      `SELECT id, tenant_id, title, public_slug FROM forms WHERE public_slug = $1`,
      [slug],
    );
    if (form.rowCount !== 1) {
      throw new NotFoundException("form not found");
    }
    const fields = await this.pool.query(
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

  toPublicForm(resolved: ResolvedForm): PublicForm {
    const { tenantId: _omitted, ...pub } = resolved;
    return pub;
  }
}
```

- [ ] **Step 4: Write `apps/api/src/public/public.controller.ts`** (GET only for now)

```ts
import { Controller, Get, Param } from "@nestjs/common";
import { Public } from "../auth/auth.guard";
import { PublicService } from "./public.service";

@Public()
@Controller("f")
export class PublicController {
  constructor(private readonly service: PublicService) {}

  @Get(":slug")
  async getForm(@Param("slug") slug: string) {
    return this.service.toPublicForm(await this.service.resolvePublishedForm(slug));
  }
}
```

- [ ] **Step 5: Write `apps/api/src/public/public.module.ts`** (controller + service, exports PublicService) and wire into AppModule.

```ts
import { Module } from "@nestjs/common";
import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";

@Module({
  controllers: [PublicController],
  providers: [PublicService],
  exports: [PublicService],
})
export class PublicModule {}
```

- [ ] **Step 6: Run** → public read tests green (37 api total). Build. Commit:
`git add apps/api && git commit -m "feat(api): serve published forms anonymously"`

---

### Task 3: Public submit — atomic submission + deliveries + outbox + throttle (TDD)

**Files:**
- Create: `apps/api/src/public/answers.ts`
- Modify: `apps/api/src/public/public.service.ts` (submit)
- Modify: `apps/api/src/public/public.controller.ts` (POST + @Throttle)
- Modify: `apps/api/src/app.module.ts` (ThrottlerModule + guard)
- Modify: `apps/api/src/config.ts` (throttle settings)
- Test: extend `apps/api/test/public.e2e.test.ts`; create `apps/api/test/throttle.e2e.test.ts`

- [ ] **Step 1: Add dependency** — `pnpm --filter @eventform/api add @nestjs/throttler`

- [ ] **Step 2: Extend the failing e2e `apps/api/test/public.e2e.test.ts`** — append this describe block:

```ts
describe("public form submit", () => {
  let t: TestContext;
  const sub = `pub-submit-${randomUUID()}`;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.adminPool.query(
      `DELETE FROM outbox WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = $1)`,
      [sub],
    );
    await t.adminPool.query(
      `DELETE FROM deliveries WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = $1)`,
      [sub],
    );
    await t.adminPool.query(
      `DELETE FROM submissions WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = $1)`,
      [sub],
    );
    await t.cleanupSubs([sub]);
    await t.close();
  });

  const VALID_ANSWERS = { answers: { "Your name": "Ada", Rating: "Good" } };

  it("writes submission, deliveries, and outbox rows in one transaction", async () => {
    const form = await publishForm(t, sub, "Submit target");
    const ep1 = await t.http().post("/endpoints").set(t.authed(sub))
      .send({ name: "e1", url: "https://example.com/1" }).expect(201);
    await t.http().post("/endpoints").set(t.authed(sub))
      .send({ name: "e2", url: "https://example.com/2" }).expect(201);
    const inactive = await t.http().post("/endpoints").set(t.authed(sub))
      .send({ name: "off", url: "https://example.com/off" }).expect(201);
    await t.http().put(`/endpoints/${inactive.body.id}`).set(t.authed(sub))
      .send({ active: false }).expect(200);

    const res = await t.http().post(`/f/${form.publicSlug}`).send(VALID_ANSWERS).expect(201);
    expect(res.body.submissionId).toMatch(/^[0-9a-f-]{36}$/);

    const subs = await t.adminPool.query("SELECT * FROM submissions WHERE id = $1", [res.body.submissionId]);
    expect(subs.rowCount).toBe(1);
    expect(subs.rows[0].answers).toEqual(VALID_ANSWERS.answers);

    const deliveries = await t.adminPool.query(
      "SELECT * FROM deliveries WHERE submission_id = $1 ORDER BY created_at", [res.body.submissionId]);
    expect(deliveries.rowCount).toBe(2); // inactive endpoint excluded
    expect(deliveries.rows.every((d: { status: string }) => d.status === "pending")).toBe(true);

    const outbox = await t.adminPool.query(
      "SELECT * FROM outbox WHERE aggregate_id = ANY($1)",
      [deliveries.rows.map((d: { id: string }) => d.id)]);
    expect(outbox.rowCount).toBe(2);
    for (const row of outbox.rows) {
      expect(row.event_type).toBe("submission.received");
      expect(row.aggregate_type).toBe("delivery");
      const delivery = deliveries.rows.find((d: { id: string }) => d.id === row.aggregate_id);
      expect(delivery.event_id).toBe(row.id);
      // payload must validate against the shared contract and embed its own ids
      const { submissionReceivedSchema } = await import("@eventform/shared");
      const payload = submissionReceivedSchema.parse(row.payload);
      expect(payload.eventId).toBe(row.id);
      expect(payload.deliveryId).toBe(row.aggregate_id);
      expect(payload.endpointId).toBe(delivery.endpoint_id);
      expect(payload.attempt).toBe(1);
      expect(payload.answers).toEqual(VALID_ANSWERS.answers);
    }
    expect(outbox.rows.map((r: { id: string }) => r.id)).toContain(
      deliveries.rows.find((d: { endpoint_id: string }) => d.endpoint_id === ep1.body.id)!.event_id,
    );
  });

  it("saves a submission with zero deliveries when no active endpoints exist", async () => {
    const lonelySub = `pub-lonely-${randomUUID()}`;
    const form = await publishForm(t, lonelySub, "No endpoints");
    const res = await t.http().post(`/f/${form.publicSlug}`).send(VALID_ANSWERS).expect(201);
    const deliveries = await t.adminPool.query(
      "SELECT count(*)::int AS n FROM deliveries WHERE submission_id = $1", [res.body.submissionId]);
    expect(deliveries.rows[0].n).toBe(0);
    await t.adminPool.query("DELETE FROM submissions WHERE id = $1", [res.body.submissionId]);
    await t.cleanupSubs([lonelySub]);
  });

  it("validates answers: missing required, unknown key, bad option, non-string", async () => {
    const form = await publishForm(t, sub, "Validation");
    await t.http().post(`/f/${form.publicSlug}`).send({ answers: { Rating: "Good" } }).expect(400);
    await t.http().post(`/f/${form.publicSlug}`)
      .send({ answers: { "Your name": "Ada", Nope: "x" } }).expect(400);
    await t.http().post(`/f/${form.publicSlug}`)
      .send({ answers: { "Your name": "Ada", Rating: "Meh" } }).expect(400);
    await t.http().post(`/f/${form.publicSlug}`)
      .send({ answers: { "Your name": 42 } }).expect(400);
    await t.http().post(`/f/${form.publicSlug}`).send({}).expect(400);
  });

  it("404s submits to drafts", async () => {
    const draft = await t.http().post("/forms").set(t.authed(sub)).send({ title: "D" }).expect(201);
    await t.http().post(`/f/${draft.body.publicSlug}`).send(VALID_ANSWERS).expect(404);
  });
});
```

- [ ] **Step 3: Run → red.**

- [ ] **Step 4: Write `apps/api/src/public/answers.ts`**

```ts
import type { PublicField } from "./public.service";

const MAX_TEXT_LENGTH = 5000;

/** Returns human-readable validation errors; empty array = valid. */
export function validateAnswers(
  fields: PublicField[],
  answers: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const byLabel = new Map(fields.map((f) => [f.label, f]));

  for (const key of Object.keys(answers)) {
    if (!byLabel.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  for (const field of fields) {
    const value = answers[field.label];
    if (value === undefined || value === "") {
      if (field.required) {
        errors.push(`missing required field: ${field.label}`);
      }
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`field must be a string: ${field.label}`);
      continue;
    }
    if (field.type === "multiple_choice" && !(field.options ?? []).includes(value)) {
      errors.push(`invalid option for field: ${field.label}`);
    }
    if (field.type === "text" && value.length > MAX_TEXT_LENGTH) {
      errors.push(`answer too long for field: ${field.label}`);
    }
  }
  return errors;
}
```

- [ ] **Step 5: Add submit to `public.service.ts`**

```ts
// additional imports at top of file:
import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
import { deliveries, endpoints, outbox, submissions, withTenant } from "@eventform/db";
import type { SubmissionReceivedEvent } from "@eventform/shared";
import { validateAnswers } from "./answers";

// inside PublicService:
  async submit(
    slug: string,
    body: { answers?: Record<string, unknown> },
    sourceIp: string | undefined,
  ): Promise<{ submissionId: string }> {
    const form = await this.resolvePublishedForm(slug);
    const rawAnswers = body?.answers;
    if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
      throw new BadRequestException({ message: "Validation failed", errors: ["answers object required"] });
    }
    const errors = validateAnswers(form.fields, rawAnswers);
    if (errors.length > 0) {
      throw new BadRequestException({ message: "Validation failed", errors });
    }
    const answers = rawAnswers as Record<string, string>;
    const submittedAt = new Date();

    return withTenant(this.pool, form.tenantId, async (db) => {
      const [submission] = await db
        .insert(submissions)
        .values({ formId: form.id, tenantId: form.tenantId, answers, sourceIp, submittedAt })
        .returning();

      const activeEndpoints = await db
        .select()
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, form.tenantId), eq(endpoints.active, true)));

      for (const endpoint of activeEndpoints) {
        const deliveryId = randomUUID();
        const eventId = randomUUID();
        const payload: SubmissionReceivedEvent = {
          eventId,
          type: "submission.received",
          attempt: 1,
          tenantId: form.tenantId,
          formId: form.id,
          formTitle: form.title,
          submissionId: submission.id,
          endpointId: endpoint.id,
          deliveryId,
          answers,
          submittedAt: submittedAt.toISOString(),
        };
        await db.insert(deliveries).values({
          id: deliveryId,
          tenantId: form.tenantId,
          endpointId: endpoint.id,
          submissionId: submission.id,
          eventId,
        });
        await db.insert(outbox).values({
          id: eventId,
          tenantId: form.tenantId,
          aggregateType: "delivery",
          aggregateId: deliveryId,
          eventType: "submission.received",
          payload,
        });
      }
      return { submissionId: submission.id };
    });
  }
```

- [ ] **Step 6: Add POST route + throttling**

`config.ts` — extend `ApiConfig` and `loadConfig` with:
```ts
  // in ApiConfig:
  throttleTtlSeconds: number;
  throttleLimit: number;
  publicSubmitLimit: number;
  // in loadConfig return:
  throttleTtlSeconds: Number(env.THROTTLE_TTL_SECONDS ?? 60),
  throttleLimit: Number(env.THROTTLE_LIMIT ?? 120),
  publicSubmitLimit: Number(env.PUBLIC_SUBMIT_THROTTLE_LIMIT ?? 10),
```

`app.module.ts` — add:
```ts
import { ThrottlerGuard, ThrottlerModule, seconds } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { loadConfig } from "./config";
// in imports:
ThrottlerModule.forRoot({
  throttlers: [
    { ttl: seconds(loadConfig().throttleTtlSeconds), limit: loadConfig().throttleLimit },
  ],
}),
// in providers (BEFORE the auth guard provider so throttling runs first):
{ provide: APP_GUARD, useClass: ThrottlerGuard },
```

`public.controller.ts` — add the POST handler:
```ts
import { Body, Controller, Get, HttpCode, Ip, Param, Post } from "@nestjs/common";
import { Throttle, seconds } from "@nestjs/throttler";
import { loadConfig } from "../config";

  @Post(":slug")
  @HttpCode(201)
  @Throttle({
    default: {
      ttl: seconds(loadConfig().throttleTtlSeconds),
      limit: loadConfig().publicSubmitLimit,
    },
  })
  submit(
    @Param("slug") slug: string,
    @Body() body: { answers?: Record<string, unknown> },
    @Ip() ip: string,
  ) {
    return this.service.submit(slug, body, ip);
  }
```

- [ ] **Step 7: Write `apps/api/test/throttle.e2e.test.ts`** — own app, fresh throttler storage:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, publishForm, TestContext } from "./utils";

describe("public submit throttling", () => {
  let t: TestContext;
  const sub = `throttle-${randomUUID()}`;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.adminPool.query(
      `DELETE FROM outbox WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = $1)`, [sub]);
    await t.adminPool.query(
      `DELETE FROM deliveries WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = $1)`, [sub]);
    await t.adminPool.query(
      `DELETE FROM submissions WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = $1)`, [sub]);
    await t.cleanupSubs([sub]);
    await t.close();
  });

  it("returns 429 after the per-IP submit budget is exhausted", async () => {
    const form = await publishForm(t, sub, "Throttle me");
    const answers = { answers: { "Your name": "Ada" } };
    for (let i = 0; i < 10; i++) {
      await t.http().post(`/f/${form.publicSlug}`).send(answers).expect(201);
    }
    await t.http().post(`/f/${form.publicSlug}`).send(answers).expect(429);
  });
});
```

- [ ] **Step 8: Run all api tests TWICE** — expect 43 green each run (35 + 5 submit + 1 throttle + 2 from Task 2 already counted; verify actual count and report). Root `pnpm test`. Build clean.

- [ ] **Step 9: Add `THROTTLE_TTL_SECONDS`, `THROTTLE_LIMIT`, `PUBLIC_SUBMIT_THROTTLE_LIMIT` to `.env.example`** (commented defaults).

- [ ] **Step 10: Commit** — `git add apps/api .env.example pnpm-lock.yaml && git commit -m "feat(api): atomic public submission with outbox writes and per-ip throttling"`

---

### Task 4: Submissions listing (TDD)

**Files:**
- Create: `apps/api/src/submissions/submissions.module.ts`, `submissions.controller.ts`, `submissions.service.ts`
- Test: `apps/api/test/submissions.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Failing e2e `apps/api/test/submissions.e2e.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, publishForm, TestContext } from "./utils";

describe("submissions listing", () => {
  let t: TestContext;
  const subA = `subs-a-${randomUUID()}`;
  const subB = `subs-b-${randomUUID()}`;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    for (const s of [subA, subB]) {
      await t.adminPool.query(
        `DELETE FROM submissions WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = $1)`, [s]);
    }
    await t.cleanupSubs([subA, subB]);
    await t.close();
  });

  it("lists own submissions newest-first", async () => {
    const form = await publishForm(t, subA, "Sub list");
    await t.http().post(`/f/${form.publicSlug}`).send({ answers: { "Your name": "First" } }).expect(201);
    await t.http().post(`/f/${form.publicSlug}`).send({ answers: { "Your name": "Second" } }).expect(201);

    const res = await t.http().get(`/forms/${form.id}/submissions`).set(t.authed(subA)).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].answers["Your name"]).toBe("Second");
    expect(res.body[1].answers["Your name"]).toBe("First");
  });

  it("404s for another tenant's form", async () => {
    const form = await publishForm(t, subA, "Iso subs");
    await t.http().get(`/forms/${form.id}/submissions`).set(t.authed(subB)).expect(404);
  });
});
```

- [ ] **Step 2: Run → red.**

- [ ] **Step 3: Implement.** `submissions.service.ts`:

```ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { desc, eq } from "drizzle-orm";
import { forms, submissions, withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";

@Injectable()
export class SubmissionsService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  listForForm(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId));
      if (!form) {
        throw new NotFoundException("form not found");
      }
      return db
        .select()
        .from(submissions)
        .where(eq(submissions.formId, formId))
        .orderBy(desc(submissions.submittedAt));
    });
  }
}
```

`submissions.controller.ts`:

```ts
import { Controller, Get, Param } from "@nestjs/common";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenants.service";
import { uuidSchema } from "../forms/forms.schemas";
import { ZodValidationPipe } from "../zod.pipe";
import { SubmissionsService } from "./submissions.service";

const uuidPipe = new ZodValidationPipe(uuidSchema);

@Controller("forms/:id/submissions")
export class SubmissionsController {
  constructor(private readonly service: SubmissionsService) {}

  @Get()
  list(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) formId: string) {
    return this.service.listForForm(tenant.id, formId);
  }
}
```

`submissions.module.ts` mirrors the others (controller + provider). Wire into AppModule.

- [ ] **Step 4: Run twice, build, commit** — `git add apps/api && git commit -m "feat(api): list form submissions"`

---

### Task 5: Deliveries API — list, detail, manual retry (TDD)

**Files:**
- Create: `apps/api/src/deliveries/deliveries.schemas.ts`, `deliveries.service.ts`, `deliveries.controller.ts`, `deliveries.module.ts`
- Test: `apps/api/test/deliveries.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Failing e2e `apps/api/test/deliveries.e2e.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, publishForm, TestContext } from "./utils";

describe("deliveries api", () => {
  let t: TestContext;
  const subA = `del-a-${randomUUID()}`;
  const subB = `del-b-${randomUUID()}`;

  async function makeDelivery(sub: string) {
    const form = await publishForm(t, sub, `Form ${randomUUID().slice(0, 8)}`);
    const ep = await t.http().post("/endpoints").set(t.authed(sub))
      .send({ name: "hook", url: "https://example.com/h" }).expect(201);
    const res = await t.http().post(`/f/${form.publicSlug}`)
      .send({ answers: { "Your name": "Ada" } }).expect(201);
    const rows = await t.adminPool.query(
      "SELECT id FROM deliveries WHERE submission_id = $1", [res.body.submissionId]);
    return { deliveryId: rows.rows[0].id as string, endpointId: ep.body.id as string };
  }

  async function forceStatus(deliveryId: string, status: string) {
    await t.adminPool.query("UPDATE deliveries SET status = $2 WHERE id = $1", [deliveryId, status]);
  }

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    for (const s of [subA, subB]) {
      for (const table of ["outbox", "delivery_attempts", "deliveries", "submissions"]) {
        await t.adminPool.query(
          `DELETE FROM ${table} WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = $1)`, [s]);
      }
    }
    await t.cleanupSubs([subA, subB]);
    await t.close();
  });

  it("lists own deliveries with endpoint names and filters by status", async () => {
    const { deliveryId } = await makeDelivery(subA);
    const all = await t.http().get("/deliveries").set(t.authed(subA)).expect(200);
    expect(all.body.some((d: { id: string }) => d.id === deliveryId)).toBe(true);
    expect(all.body[0].endpointName).toBeDefined();

    await forceStatus(deliveryId, "failed");
    const failed = await t.http().get("/deliveries?status=failed").set(t.authed(subA)).expect(200);
    expect(failed.body.some((d: { id: string }) => d.id === deliveryId)).toBe(true);
    const pending = await t.http().get("/deliveries?status=pending").set(t.authed(subA)).expect(200);
    expect(pending.body.some((d: { id: string }) => d.id === deliveryId)).toBe(false);
  });

  it("rejects invalid status filters", async () => {
    await t.http().get("/deliveries?status=nope").set(t.authed(subA)).expect(400);
  });

  it("returns delivery detail with attempts", async () => {
    const { deliveryId } = await makeDelivery(subA);
    await t.adminPool.query(
      `INSERT INTO delivery_attempts (delivery_id, tenant_id, attempt_no, response_code, error, duration_ms)
       SELECT id, tenant_id, 1, 500, 'boom', 42 FROM deliveries WHERE id = $1`, [deliveryId]);
    const res = await t.http().get(`/deliveries/${deliveryId}`).set(t.authed(subA)).expect(200);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0]).toMatchObject({ attemptNo: 1, responseCode: 500, error: "boom" });
  });

  it("retries a failed delivery: resets budget and emits a fresh outbox event", async () => {
    const { deliveryId } = await makeDelivery(subA);
    const before = await t.adminPool.query("SELECT event_id FROM deliveries WHERE id = $1", [deliveryId]);
    await t.adminPool.query(
      "UPDATE deliveries SET status = 'failed', attempt_count = 3, last_error = 'x', response_code = 500 WHERE id = $1",
      [deliveryId]);

    const res = await t.http().post(`/deliveries/${deliveryId}/retry`).set(t.authed(subA)).expect(201);
    expect(res.body).toMatchObject({ id: deliveryId, status: "pending", attemptCount: 0 });

    const after = await t.adminPool.query(
      "SELECT event_id, status, attempt_count, last_error, response_code FROM deliveries WHERE id = $1",
      [deliveryId]);
    expect(after.rows[0].event_id).not.toBe(before.rows[0].event_id);
    expect(after.rows[0]).toMatchObject({ status: "pending", attempt_count: 0, last_error: null, response_code: null });

    const outboxRow = await t.adminPool.query("SELECT * FROM outbox WHERE id = $1", [after.rows[0].event_id]);
    expect(outboxRow.rowCount).toBe(1);
    const { submissionReceivedSchema } = await import("@eventform/shared");
    const payload = submissionReceivedSchema.parse(outboxRow.rows[0].payload);
    expect(payload.attempt).toBe(1);
    expect(payload.deliveryId).toBe(deliveryId);
  });

  it("409s retry of non-failed deliveries", async () => {
    const { deliveryId } = await makeDelivery(subA);
    await t.http().post(`/deliveries/${deliveryId}/retry`).set(t.authed(subA)).expect(409); // pending
    await forceStatus(deliveryId, "delivered");
    await t.http().post(`/deliveries/${deliveryId}/retry`).set(t.authed(subA)).expect(409);
  });

  it("isolates deliveries across tenants", async () => {
    const { deliveryId } = await makeDelivery(subA);
    await forceStatus(deliveryId, "failed");
    await t.http().get(`/deliveries/${deliveryId}`).set(t.authed(subB)).expect(404);
    await t.http().post(`/deliveries/${deliveryId}/retry`).set(t.authed(subB)).expect(404);
    const list = await t.http().get("/deliveries").set(t.authed(subB)).expect(200);
    expect(list.body.some((d: { id: string }) => d.id === deliveryId)).toBe(false);
  });

  it("maps endpoint deletion with deliveries to 409 (FK)", async () => {
    const { endpointId } = await makeDelivery(subA);
    await t.http().delete(`/endpoints/${endpointId}`).set(t.authed(subA)).expect(409);
  });
});
```

- [ ] **Step 2: Run → red.**

- [ ] **Step 3: Write `apps/api/src/deliveries/deliveries.schemas.ts`**

```ts
import { z } from "zod";

export const listDeliveriesQuerySchema = z
  .object({
    status: z.enum(["pending", "delivered", "retrying", "failed"]).optional(),
    endpointId: z.string().uuid().optional(),
  })
  .strict();

export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;
```

- [ ] **Step 4: Write `apps/api/src/deliveries/deliveries.service.ts`**

```ts
import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { and, asc, desc, eq, SQL } from "drizzle-orm";
import {
  deliveries,
  deliveryAttempts,
  endpoints,
  forms,
  outbox,
  submissions,
  withTenant,
} from "@eventform/db";
import type { SubmissionReceivedEvent } from "@eventform/shared";
import { API_POOL } from "../db/db.module";
import { ListDeliveriesQuery } from "./deliveries.schemas";

@Injectable()
export class DeliveriesService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  list(tenantId: string, query: ListDeliveriesQuery) {
    return withTenant(this.pool, tenantId, async (db) => {
      const conditions: SQL[] = [eq(deliveries.tenantId, tenantId)];
      if (query.status) {
        conditions.push(eq(deliveries.status, query.status));
      }
      if (query.endpointId) {
        conditions.push(eq(deliveries.endpointId, query.endpointId));
      }
      const rows = await db
        .select({
          id: deliveries.id,
          endpointId: deliveries.endpointId,
          endpointName: endpoints.name,
          submissionId: deliveries.submissionId,
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
      return rows;
    });
  }

  getWithAttempts(tenantId: string, id: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, id));
      if (!delivery) {
        throw new NotFoundException("delivery not found");
      }
      const attempts = await db
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, id))
        .orderBy(asc(deliveryAttempts.attemptNo));
      return { ...delivery, attempts };
    });
  }

  /** Manual retry: failed-only, FOR UPDATE, reset budget, re-emit through the outbox. */
  retry(tenantId: string, id: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [delivery] = await db
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, id))
        .for("update");
      if (!delivery) {
        throw new NotFoundException("delivery not found");
      }
      if (delivery.status !== "failed") {
        throw new ConflictException("only failed deliveries can be retried");
      }

      const [submission] = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, delivery.submissionId));
      const [form] = await db.select().from(forms).where(eq(forms.id, submission.formId));
      const eventId = randomUUID();
      const payload: SubmissionReceivedEvent = {
        eventId,
        type: "submission.received",
        attempt: 1,
        tenantId,
        formId: form.id,
        formTitle: form.title,
        submissionId: submission.id,
        endpointId: delivery.endpointId,
        deliveryId: delivery.id,
        answers: submission.answers,
        submittedAt: submission.submittedAt.toISOString(),
      };
      await db.insert(outbox).values({
        id: eventId,
        tenantId,
        aggregateType: "delivery",
        aggregateId: delivery.id,
        eventType: "submission.received",
        payload,
      });
      const [updated] = await db
        .update(deliveries)
        .set({
          status: "pending",
          attemptCount: 0,
          eventId,
          nextRetryAt: null,
          lastError: null,
          responseCode: null,
        })
        .where(eq(deliveries.id, id))
        .returning();
      return updated;
    });
  }
}
```

- [ ] **Step 5: Write `apps/api/src/deliveries/deliveries.controller.ts`**

```ts
import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenants.service";
import { uuidSchema } from "../forms/forms.schemas";
import { ZodValidationPipe } from "../zod.pipe";
import { ListDeliveriesQuery, listDeliveriesQuerySchema } from "./deliveries.schemas";
import { DeliveriesService } from "./deliveries.service";

const uuidPipe = new ZodValidationPipe(uuidSchema);

@Controller("deliveries")
export class DeliveriesController {
  constructor(private readonly service: DeliveriesService) {}

  @Get()
  list(
    @CurrentTenant() tenant: Tenant,
    @Query(new ZodValidationPipe(listDeliveriesQuerySchema)) query: ListDeliveriesQuery,
  ) {
    return this.service.list(tenant.id, query);
  }

  @Get(":id")
  get(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.service.getWithAttempts(tenant.id, id);
  }

  @Post(":id/retry")
  retry(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.service.retry(tenant.id, id);
  }
}
```

- [ ] **Step 6: Write `deliveries.module.ts`** (controller + provider), wire into AppModule.

```ts
import { Module } from "@nestjs/common";
import { DeliveriesController } from "./deliveries.controller";
import { DeliveriesService } from "./deliveries.service";

@Module({
  controllers: [DeliveriesController],
  providers: [DeliveriesService],
})
export class DeliveriesModule {}
```

- [ ] **Step 7: Run all api tests TWICE; root suite; build.** Report exact counts.

- [ ] **Step 8: Commit** — `git add apps/api && git commit -m "feat(api): deliveries listing, detail, and outbox-routed manual retry"`

---

### Task 6: README + plan notes + full verification

- [ ] **Step 1:** Update README "Repo layout": `apps/api` line drops "*(phase 2)*" and becomes "NestJS REST API — auth, forms, endpoints, public submission, deliveries". Add Phase 2b plan link under Design docs.
- [ ] **Step 2:** Append an "Implementation notes" section to this plan file recording any deviations that occurred during Tasks 1–5.
- [ ] **Step 3:** Full verification: `pnpm build && pnpm test` (report counts); boot `PORT=3196 node apps/api/dist/main.js`, curl `/health`, GET a published form by slug anonymously, kill.
- [ ] **Step 4: Commit** — `git add README.md docs && git commit -m "docs: mark api phase complete in readme"`

## Done criteria for Phase 2b

- Root suite green (expect ~85+ tests; exact count recorded in Task 6).
- A public form can be fetched and submitted anonymously; every active endpoint
  gets a `pending` delivery and a schema-valid `submission.received` outbox row
  in the SAME transaction.
- Manual retry of a failed delivery resets the budget and lands a fresh outbox
  event with `attempt: 1` (verified by test).
- `DELETE /endpoints/:id` with deliveries → 409; no SQL/params in any error
  response or log line.
- Phase 3 (Debezium + Kafka + worker) can consume `outbox` rows as-is.
