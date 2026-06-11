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
