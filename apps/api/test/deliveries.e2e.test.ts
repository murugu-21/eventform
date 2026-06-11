import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, publishForm, TestContext } from "./utils";

describe("deliveries api", () => {
  let t: TestContext;
  const subA = `del-a-${randomUUID()}`;
  const subB = `del-b-${randomUUID()}`;

  async function makeDelivery(sub: string) {
    const form = await publishForm(t, sub, `Form ${randomUUID().slice(0, 8)}`);
    const ep = await t.http().post("/protected/v1/endpoints").set(t.authed(sub))
      .send({ name: "hook", url: "https://example.com/h" }).expect(201);
    const res = await t.http().post(`/v1/forms/${form.publicSlug}`)
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
    const all = await t.http().get("/protected/v1/deliveries").set(t.authed(subA)).expect(200);
    expect(all.body.some((d: { id: string }) => d.id === deliveryId)).toBe(true);
    expect(all.body[0].endpointName).toBeDefined();

    await forceStatus(deliveryId, "failed");
    const failed = await t.http().get("/protected/v1/deliveries?status=failed").set(t.authed(subA)).expect(200);
    expect(failed.body.some((d: { id: string }) => d.id === deliveryId)).toBe(true);
    const pending = await t.http().get("/protected/v1/deliveries?status=pending").set(t.authed(subA)).expect(200);
    expect(pending.body.some((d: { id: string }) => d.id === deliveryId)).toBe(false);
  });

  it("rejects invalid status filters", async () => {
    await t.http().get("/protected/v1/deliveries?status=nope").set(t.authed(subA)).expect(400);
  });

  it("returns delivery detail with attempts", async () => {
    const { deliveryId } = await makeDelivery(subA);
    await t.adminPool.query(
      `INSERT INTO delivery_attempts (delivery_id, tenant_id, attempt_no, response_code, error, duration_ms)
       SELECT id, tenant_id, 1, 500, 'boom', 42 FROM deliveries WHERE id = $1`, [deliveryId]);
    const res = await t.http().get(`/protected/v1/deliveries/${deliveryId}`).set(t.authed(subA)).expect(200);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0]).toMatchObject({ attemptNo: 1, responseCode: 500, error: "boom" });
  });

  it("retries a failed delivery: resets budget and emits a fresh outbox event", async () => {
    const { deliveryId } = await makeDelivery(subA);
    const before = await t.adminPool.query("SELECT event_id FROM deliveries WHERE id = $1", [deliveryId]);
    await t.adminPool.query(
      "UPDATE deliveries SET status = 'failed', attempt_count = 3, last_error = 'x', response_code = 500 WHERE id = $1",
      [deliveryId]);

    const res = await t.http().post(`/protected/v1/deliveries/${deliveryId}/retry`).set(t.authed(subA)).expect(201);
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
    await t.http().post(`/protected/v1/deliveries/${deliveryId}/retry`).set(t.authed(subA)).expect(409); // pending
    await forceStatus(deliveryId, "delivered");
    await t.http().post(`/protected/v1/deliveries/${deliveryId}/retry`).set(t.authed(subA)).expect(409);
  });

  it("isolates deliveries across tenants", async () => {
    const { deliveryId } = await makeDelivery(subA);
    await forceStatus(deliveryId, "failed");
    await t.http().get(`/protected/v1/deliveries/${deliveryId}`).set(t.authed(subB)).expect(404);
    await t.http().post(`/protected/v1/deliveries/${deliveryId}/retry`).set(t.authed(subB)).expect(404);
    const list = await t.http().get("/protected/v1/deliveries").set(t.authed(subB)).expect(200);
    expect(list.body.some((d: { id: string }) => d.id === deliveryId)).toBe(false);
  });

  it("maps endpoint deletion with deliveries to 409 (FK)", async () => {
    const { endpointId } = await makeDelivery(subA);
    await t.http().delete(`/protected/v1/endpoints/${endpointId}`).set(t.authed(subA)).expect(409);
  });
});
