import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { SecretCipher, verifyWebhook } from "@eventform/shared";
import { AppModule } from "../src/app.module";
import { startTestServer, TestServer } from "./test-server";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";

const cipher = new SecretCipher({
  keyId: "alias/eventform-endpoint-secrets",
  endpoint: "http://localhost:4566",
  region: "us-east-1",
});

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 60_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

describe("pipeline e2e: outbox → debezium → kafka → worker → webhook", () => {
  let app: INestApplication;
  let admin: Pool;
  let server: TestServer;
  const tenantId = randomUUID();
  const secret = "whsec_" + "0f".repeat(24);

  beforeAll(async () => {
    admin = createPool(ADMIN_URL);
    server = await startTestServer();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // consumer joins the group; first join can take ~10s
  }, 90_000);

  afterAll(async () => {
    await app.close();
    for (const table of ["outbox", "delivery_attempts", "deliveries", "submissions", "endpoints", "forms"]) {
      await admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    await admin.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await server.close();
    await admin.end();
  });

  it("delivers a signed webhook for an outbox event end-to-end", async () => {
    const formId = randomUUID();
    const endpointId = randomUUID();
    const submissionId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const ciphertext = await cipher.encrypt(secret, tenantId);

    await admin.query("INSERT INTO tenants (id, name, cognito_sub) VALUES ($1,'pipe',$2)", [
      tenantId, `pipe-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO forms (id, tenant_id, title, status, public_slug) VALUES ($1,$2,'Pipe','published',$3)",
      [formId, tenantId, `pipe-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO endpoints (id, tenant_id, name, url, secret_ciphertext) VALUES ($1,$2,'hook',$3,$4)",
      [endpointId, tenantId, server.url, ciphertext]);
    await admin.query(
      "INSERT INTO submissions (id, form_id, tenant_id, answers) VALUES ($1,$2,$3,'{\"Q\":\"pipe\"}'::jsonb)",
      [submissionId, formId, tenantId]);
    await admin.query(
      "INSERT INTO deliveries (id, tenant_id, endpoint_id, submission_id, event_id) VALUES ($1,$2,$3,$4,$5)",
      [deliveryId, tenantId, endpointId, submissionId, eventId]);

    const payload = {
      eventId, type: "submission.received", attempt: 1, tenantId, formId,
      formTitle: "Pipe", submissionId, endpointId, deliveryId,
      answers: { Q: "pipe" }, submittedAt: new Date().toISOString(),
    };
    // The atomic write the API does — here only the outbox insert is the trigger:
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'delivery',$3,'submission.received',$4)`,
      [eventId, tenantId, deliveryId, JSON.stringify(payload)]);

    const hit = await until(async () =>
      server.received.find((r) => r.headers["x-eventform-event-id"] === eventId));

    expect(
      verifyWebhook({
        secret,
        timestamp: hit.headers["x-eventform-timestamp"] as string,
        body: hit.body,
        signature: hit.headers["x-eventform-signature"] as string,
      }),
    ).toBe(true);
    const delivered = JSON.parse(hit.body);
    expect(delivered.deliveryId).toBe(deliveryId);
    expect(delivered.answers).toEqual({ Q: "pipe" });

    const row = await until(async () => {
      const res = await admin.query("SELECT * FROM deliveries WHERE id = $1", [deliveryId]);
      return res.rows[0]?.status === "delivered" ? res.rows[0] : undefined;
    });
    expect(row.attempt_count).toBe(1);
  }, 120_000);

  it("skips poison messages without crashing the consumer", async () => {
    await admin.query(
      `INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,'delivery',$2,'submission.received','{"not":"an event"}'::jsonb)`,
      [tenantId, randomUUID()]);
    // consumer must survive; prove liveness by pushing one more valid event through
    // (reuse the seeding from the first test with fresh ids):
    const formId = randomUUID(); const endpointId = randomUUID();
    const submissionId = randomUUID(); const deliveryId = randomUUID();
    const eventId = randomUUID();
    const ciphertext = await cipher.encrypt(secret, tenantId);
    await admin.query(
      "INSERT INTO forms (id, tenant_id, title, status, public_slug) VALUES ($1,$2,'P2','published',$3)",
      [formId, tenantId, `pipe2-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO endpoints (id, tenant_id, name, url, secret_ciphertext) VALUES ($1,$2,'h2',$3,$4)",
      [endpointId, tenantId, server.url, ciphertext]);
    await admin.query(
      "INSERT INTO submissions (id, form_id, tenant_id, answers) VALUES ($1,$2,$3,'{\"Q\":\"2\"}'::jsonb)",
      [submissionId, formId, tenantId]);
    await admin.query(
      "INSERT INTO deliveries (id, tenant_id, endpoint_id, submission_id, event_id) VALUES ($1,$2,$3,$4,$5)",
      [deliveryId, tenantId, endpointId, submissionId, eventId]);
    const payload = {
      eventId, type: "submission.received", attempt: 1, tenantId, formId,
      formTitle: "P2", submissionId, endpointId, deliveryId,
      answers: { Q: "2" }, submittedAt: new Date().toISOString(),
    };
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'delivery',$3,'submission.received',$4)`,
      [eventId, tenantId, deliveryId, JSON.stringify(payload)]);

    const hit = await until(async () =>
      server.received.find((r) => r.headers["x-eventform-event-id"] === eventId));
    expect(hit).toBeDefined();
  }, 120_000);
});
