import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { submissionReceivedSchema } from "@eventform/shared";
import { RetryScheduler } from "../src/scheduler/retry-scheduler.service";
import { OutboxCleanup } from "../src/scheduler/outbox-cleanup.service";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";
const WORKER_URL =
  process.env.DATABASE_URL_WORKER ?? "postgres://app_worker:app_worker_dev@localhost:5432/eventform";

describe("RetryScheduler", () => {
  let admin: Pool;
  let workerPool: Pool;
  let scheduler: RetryScheduler;
  const tenantId = randomUUID();

  async function seedRetrying(opts: { dueInMs: number; attemptCount?: number }) {
    const formId = randomUUID(); const endpointId = randomUUID();
    const submissionId = randomUUID(); const deliveryId = randomUUID();
    await admin.query(
      "INSERT INTO forms (id, tenant_id, title, status, public_slug) VALUES ($1,$2,'Sched','published',$3)",
      [formId, tenantId, `sched-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO endpoints (id, tenant_id, name, url, secret_ciphertext) VALUES ($1,$2,'ep','https://example.com/h','ct')",
      [endpointId, tenantId]);
    await admin.query(
      "INSERT INTO submissions (id, form_id, tenant_id, answers) VALUES ($1,$2,$3,'{\"Q\":\"s\"}'::jsonb)",
      [submissionId, formId, tenantId]);
    await admin.query(
      `INSERT INTO deliveries (id, tenant_id, endpoint_id, submission_id, event_id, status, attempt_count, next_retry_at)
       VALUES ($1,$2,$3,$4,$5,'retrying',$6, now() + ($7 || ' milliseconds')::interval)`,
      [deliveryId, tenantId, endpointId, submissionId, randomUUID(), opts.attemptCount ?? 1, String(opts.dueInMs)]);
    return { deliveryId, submissionId };
  }

  beforeAll(async () => {
    admin = createPool(ADMIN_URL);
    workerPool = createPool(WORKER_URL);
    await admin.query("INSERT INTO tenants (id, name, cognito_sub) VALUES ($1,'sched',$2)", [
      tenantId, `sched-${randomUUID()}`]);
    scheduler = new RetryScheduler(workerPool);
  });

  afterAll(async () => {
    for (const table of ["outbox", "deliveries", "submissions", "endpoints", "forms"]) {
      await admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await admin.end();
    await workerPool.end();
  });

  it("re-emits due retrying deliveries through the outbox", async () => {
    const { deliveryId } = await seedRetrying({ dueInMs: -1000, attemptCount: 1 });
    const claimed = await scheduler.tick();
    expect(claimed).toBeGreaterThanOrEqual(1);

    const row = await admin.query("SELECT * FROM deliveries WHERE id = $1", [deliveryId]);
    expect(row.rows[0].status).toBe("pending");

    const outboxRow = await admin.query("SELECT * FROM outbox WHERE aggregate_id = $1", [deliveryId]);
    expect(outboxRow.rowCount).toBe(1);
    expect(outboxRow.rows[0].id).toBe(row.rows[0].event_id); // delivery points at the new event
    const payload = submissionReceivedSchema.parse(outboxRow.rows[0].payload);
    expect(payload.attempt).toBe(2); // attempt_count 1 → next attempt is 2
    expect(payload.deliveryId).toBe(deliveryId);
  });

  it("leaves not-yet-due and non-retrying deliveries alone", async () => {
    const { deliveryId: future } = await seedRetrying({ dueInMs: 60_000 });
    await scheduler.tick();
    const row = await admin.query("SELECT status FROM deliveries WHERE id = $1", [future]);
    expect(row.rows[0].status).toBe("retrying");
  });

  it("two concurrent ticks never double-claim (SKIP LOCKED)", async () => {
    await seedRetrying({ dueInMs: -1000 });
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    // every due delivery claimed exactly once across both ticks
    const dupes = await admin.query(
      `SELECT aggregate_id, count(*) FROM outbox WHERE tenant_id = $1
       GROUP BY aggregate_id HAVING count(*) > 1`, [tenantId]);
    expect(dupes.rowCount).toBe(0);
    expect(a + b).toBeGreaterThanOrEqual(1);
  });
});

describe("OutboxCleanup", () => {
  it("prunes outbox rows older than the retention window", async () => {
    const admin = createPool(ADMIN_URL);
    const workerPool = createPool(WORKER_URL);
    const old = randomUUID();
    const fresh = randomUUID();
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ($1, gen_random_uuid(), 'delivery', gen_random_uuid(), 'cleanup-test', '{}'::jsonb, now() - interval '25 hours')`,
      [old]);
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, gen_random_uuid(), 'delivery', gen_random_uuid(), 'cleanup-test', '{}'::jsonb)`,
      [fresh]);

    const cleanup = new OutboxCleanup(workerPool, 24);
    const pruned = await cleanup.tick();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const rows = await admin.query("SELECT id FROM outbox WHERE event_type = 'cleanup-test'");
    expect(rows.rows.map((r) => r.id)).toEqual([fresh]);

    await admin.query("DELETE FROM outbox WHERE event_type = 'cleanup-test'");
    await admin.end();
    await workerPool.end();
  });
});
