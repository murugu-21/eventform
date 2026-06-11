import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, TestContext } from "./utils";

describe("endpoints", () => {
  let t: TestContext;
  const subA = `ep-a-${randomUUID()}`;
  const subB = `ep-b-${randomUUID()}`;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.cleanupSubs([subA, subB]);
    await t.close();
  });

  it("creates an endpoint and returns the secret exactly once", async () => {
    const res = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "CI hook", url: "https://example.com/hook" })
      .expect(201);
    expect(res.body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(res.body).toMatchObject({ name: "CI hook", url: "https://example.com/hook", active: true });

    const list = await t.http().get("/endpoints").set(t.authed(subA)).expect(200);
    expect(list.body[0].secret).toBeUndefined();
    expect(list.body[0].secretCiphertext).toBeUndefined();
  });

  it("stores only ciphertext at rest", async () => {
    const res = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "At rest", url: "https://example.com/x" })
      .expect(201);
    const row = await t.adminPool.query(
      "SELECT secret_ciphertext FROM endpoints WHERE id = $1",
      [res.body.id],
    );
    expect(row.rows[0].secret_ciphertext).not.toContain(res.body.secret);
    expect(row.rows[0].secret_ciphertext).not.toMatch(/^whsec_/);
  });

  it("reveals the secret via KMS decrypt", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "Reveal", url: "https://example.com/r" })
      .expect(201);
    const revealed = await t.http()
      .get(`/endpoints/${created.body.id}/secret`)
      .set(t.authed(subA))
      .expect(200);
    expect(revealed.body.secret).toBe(created.body.secret);
  });

  it("rotates the secret", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "Rotate", url: "https://example.com/ro" })
      .expect(201);
    const rotated = await t.http()
      .post(`/endpoints/${created.body.id}/rotate`)
      .set(t.authed(subA))
      .expect(201);
    expect(rotated.body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(rotated.body.secret).not.toBe(created.body.secret);
    const revealed = await t.http()
      .get(`/endpoints/${created.body.id}/secret`)
      .set(t.authed(subA))
      .expect(200);
    expect(revealed.body.secret).toBe(rotated.body.secret);
  });

  it("updates name/url/active", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "U", url: "https://example.com/u" })
      .expect(201);
    const res = await t.http()
      .put(`/endpoints/${created.body.id}`)
      .set(t.authed(subA))
      .send({ active: false, name: "U2" })
      .expect(200);
    expect(res.body).toMatchObject({ active: false, name: "U2" });
  });

  it("rejects non-http(s) urls", async () => {
    await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "ftp", url: "ftp://example.com" })
      .expect(400);
  });

  it("deletes an endpoint", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "Del", url: "https://example.com/d" })
      .expect(201);
    await t.http().delete(`/endpoints/${created.body.id}`).set(t.authed(subA)).expect(204);
    await t.http().get(`/endpoints/${created.body.id}/secret`).set(t.authed(subA)).expect(404);
  });

  it("isolates endpoints between tenants (404 cross-tenant)", async () => {
    const created = await t.http()
      .post("/endpoints")
      .set(t.authed(subA))
      .send({ name: "Iso", url: "https://example.com/i" })
      .expect(201);
    await t.http().get(`/endpoints/${created.body.id}/secret`).set(t.authed(subB)).expect(404);
    await t.http().post(`/endpoints/${created.body.id}/rotate`).set(t.authed(subB)).expect(404);
    await t.http().delete(`/endpoints/${created.body.id}`).set(t.authed(subB)).expect(404);
  });
});
