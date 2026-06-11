import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { SecretCipher, SubmissionReceivedEvent } from "@eventform/shared";
import { DeliveryProcessor } from "../src/processor/delivery-processor.service";
import { WebhookSender } from "../src/webhook/webhook-sender.service";
import { startTestServer, TestServer } from "./test-server";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";
const WORKER_URL =
  process.env.DATABASE_URL_WORKER ?? "postgres://app_worker:app_worker_dev@localhost:5432/eventform";

const cipher = new SecretCipher({
  keyId: "alias/eventform-endpoint-secrets",
  endpoint: "http://localhost:4566",
  region: "us-east-1",
});

describe("DeliveryProcessor", () => {
  let admin: Pool;
  let workerPool: Pool;
  let server: TestServer;
  let processor: DeliveryProcessor;
  const tenantId = randomUUID();
  const cleanupTenants = [tenantId];

  async function seed(opts: { url?: string } = {}) {
    const formId = randomUUID();
    const endpointId = randomUUID();
    const submissionId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const secret = "whsec_" + "ee".repeat(24);
    const ciphertext = await cipher.encrypt(secret, tenantId);

    await admin.query(
      "INSERT INTO forms (id, tenant_id, title, status, public_slug) VALUES ($1,$2,'Proc form','published',$3)",
      [formId, tenantId, `proc-${randomUUID()}`],
    );
    await admin.query(
      "INSERT INTO endpoints (id, tenant_id, name, url, secret_ciphertext) VALUES ($1,$2,'ep',$3,$4)",
      [endpointId, tenantId, opts.url ?? server.url, ciphertext],
    );
    await admin.query(
      "INSERT INTO submissions (id, form_id, tenant_id, answers) VALUES ($1,$2,$3,'{\"Q\":\"A\"}'::jsonb)",
      [submissionId, formId, tenantId],
    );
    await admin.query(
      "INSERT INTO deliveries (id, tenant_id, endpoint_id, submission_id, event_id) VALUES ($1,$2,$3,$4,$5)",
      [deliveryId, tenantId, endpointId, submissionId, eventId],
    );
    const event: SubmissionReceivedEvent = {
      eventId,
      type: "submission.received",
      attempt: 1,
      tenantId,
      formId,
      formTitle: "Proc form",
      submissionId,
      endpointId,
      deliveryId,
      answers: { Q: "A" },
      submittedAt: new Date().toISOString(),
    };
    return { event, deliveryId, eventId, secret };
  }

  async function delivery(id: string) {
    const res = await admin.query("SELECT * FROM deliveries WHERE id = $1", [id]);
    return res.rows[0];
  }

  beforeAll(async () => {
    admin = createPool(ADMIN_URL);
    workerPool = createPool(WORKER_URL);
    server = await startTestServer();
    await admin.query("INSERT INTO tenants (id, name, cognito_sub) VALUES ($1,'proc',$2)", [
      tenantId,
      `proc-${randomUUID()}`,
    ]);
    processor = new DeliveryProcessor(workerPool, new WebhookSender(cipher, 1000));
  });

  afterAll(async () => {
    for (const table of ["outbox", "processed_events", "delivery_attempts", "deliveries", "submissions", "endpoints", "form_fields", "forms"]) {
      await admin.query(
        table === "processed_events"
          ? "DELETE FROM processed_events WHERE TRUE" // pruned per-test below; safe final sweep
          : `DELETE FROM ${table} WHERE tenant_id = ANY($1)`,
        table === "processed_events" ? [] : [cleanupTenants],
      );
    }
    await admin.query("DELETE FROM tenants WHERE id = ANY($1)", [cleanupTenants]);
    await server.close();
    await admin.end();
    await workerPool.end();
  });

  it("delivers, records the attempt, and marks delivered", async () => {
    const { event, deliveryId } = await seed();
    const outcome = await processor.process(event);
    expect(outcome).toBe("delivered");

    const row = await delivery(deliveryId);
    expect(row.status).toBe("delivered");
    expect(row.attempt_count).toBe(1);
    expect(row.response_code).toBe(200);
    expect(row.delivered_at).not.toBeNull();

    const attempts = await admin.query(
      "SELECT * FROM delivery_attempts WHERE delivery_id = $1", [deliveryId]);
    expect(attempts.rowCount).toBe(1);
    expect(attempts.rows[0]).toMatchObject({ attempt_no: 1, response_code: 200 });
  });

  it("is idempotent: a duplicate event sends exactly one webhook", async () => {
    const { event } = await seed();
    const before = server.received.length;
    expect(await processor.process(event)).toBe("delivered");
    expect(await processor.process(event)).toBe("duplicate");
    expect(server.received.length).toBe(before + 1);
  });

  it("schedules a retry with +5s backoff on first failure", async () => {
    server.setStatus(500);
    const { event, deliveryId } = await seed();
    expect(await processor.process(event)).toBe("retry_scheduled");
    const row = await delivery(deliveryId);
    expect(row.status).toBe("retrying");
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toContain("500");
    const deltaMs = new Date(row.next_retry_at).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(2_000);
    expect(deltaMs).toBeLessThan(8_000);
    server.setStatus(200);
  });

  it("marks failed after the third failed attempt", async () => {
    server.setStatus(500);
    const { event, deliveryId } = await seed();
    await admin.query("UPDATE deliveries SET attempt_count = 2, status = 'pending' WHERE id = $1", [deliveryId]);
    expect(await processor.process(event)).toBe("failed");
    const row = await delivery(deliveryId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(3);
    server.setStatus(200);
  });

  it("skips terminal deliveries without sending", async () => {
    const { event, deliveryId } = await seed();
    await admin.query("UPDATE deliveries SET status = 'failed' WHERE id = $1", [deliveryId]);
    const before = server.received.length;
    expect(await processor.process(event)).toBe("stale");
    expect(server.received.length).toBe(before);
  });

  it("claims orphan events (delivery row missing) without crashing", async () => {
    const { event } = await seed();
    await admin.query("DELETE FROM delivery_attempts WHERE delivery_id = $1", [event.deliveryId]);
    await admin.query("DELETE FROM deliveries WHERE id = $1", [event.deliveryId]);
    expect(await processor.process(event)).toBe("orphan");
    expect(await processor.process(event)).toBe("duplicate");
  });

  it("a crash between send and commit re-sends on redelivery (at-least-once)", async () => {
    const { event } = await seed();
    const sender = new WebhookSender(cipher, 1000);
    const exploding = new DeliveryProcessor(workerPool, sender, {
      afterSendHook: () => {
        throw new Error("simulated crash before commit");
      },
    });
    const before = server.received.length;
    await expect(exploding.process(event)).rejects.toThrow("simulated crash");
    expect(server.received.length).toBe(before + 1); // HTTP went out...
    // ...but nothing was committed:
    const claimed = await admin.query("SELECT 1 FROM processed_events WHERE event_id = $1", [event.eventId]);
    expect(claimed.rowCount).toBe(0);
    // redelivery processes cleanly end-to-end (documented duplicate webhook):
    expect(await processor.process(event)).toBe("delivered");
    expect(server.received.length).toBe(before + 2);
  });
});
