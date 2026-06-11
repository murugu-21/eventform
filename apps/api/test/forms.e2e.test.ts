import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, TestContext } from "./utils";

describe("forms", () => {
  let t: TestContext;
  const subA = `forms-a-${randomUUID()}`;
  const subB = `forms-b-${randomUUID()}`;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.cleanupSubs([subA, subB]);
    await t.close();
  });

  const FIELDS = {
    fields: [
      { type: "text", label: "Your name", required: true },
      { type: "multiple_choice", label: "Rating", options: ["Good", "Bad"], required: false },
    ],
  };

  it("creates a draft form with a public slug", async () => {
    const res = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "Feedback" }).expect(201);
    expect(res.body).toMatchObject({ title: "Feedback", status: "draft" });
    expect(res.body.publicSlug).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it("rejects an empty title", async () => {
    await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "" }).expect(400);
  });

  it("lists only the caller's forms", async () => {
    await t.http().post("/protected/v1/forms").set(t.authed(subB)).send({ title: "B form" }).expect(201);
    const listA = await t.http().get("/protected/v1/forms").set(t.authed(subA)).expect(200);
    expect(listA.body.every((f: { title: string }) => f.title !== "B form")).toBe(true);
  });

  it("replaces fields and returns them ordered", async () => {
    const form = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "F" }).expect(201);
    await t.http().put(`/protected/v1/forms/${form.body.id}/fields`).set(t.authed(subA)).send(FIELDS).expect(200);
    const got = await t.http().get(`/protected/v1/forms/${form.body.id}`).set(t.authed(subA)).expect(200);
    expect(got.body.fields).toHaveLength(2);
    expect(got.body.fields[0]).toMatchObject({ label: "Your name", position: 0 });
    expect(got.body.fields[1]).toMatchObject({ label: "Rating", position: 1, options: ["Good", "Bad"] });
  });

  it("rejects multiple_choice without options and text with options", async () => {
    const form = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "V" }).expect(201);
    await t.http()
      .put(`/protected/v1/forms/${form.body.id}/fields`)
      .set(t.authed(subA))
      .send({ fields: [{ type: "multiple_choice", label: "Pick", required: false }] })
      .expect(400);
    await t.http()
      .put(`/protected/v1/forms/${form.body.id}/fields`)
      .set(t.authed(subA))
      .send({ fields: [{ type: "text", label: "T", options: ["x", "y"], required: false }] })
      .expect(400);
  });

  it("publishes a form with fields; publish is one-way and requires fields", async () => {
    const empty = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "E" }).expect(201);
    await t.http().post(`/protected/v1/forms/${empty.body.id}/publish`).set(t.authed(subA)).expect(409);

    const form = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "P" }).expect(201);
    await t.http().put(`/protected/v1/forms/${form.body.id}/fields`).set(t.authed(subA)).send(FIELDS).expect(200);
    const pub = await t.http().post(`/protected/v1/forms/${form.body.id}/publish`).set(t.authed(subA)).expect(201);
    expect(pub.body.status).toBe("published");
    await t.http().post(`/protected/v1/forms/${form.body.id}/publish`).set(t.authed(subA)).expect(409);
  });

  it("locks fields and deletion after publish", async () => {
    const form = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "L" }).expect(201);
    await t.http().put(`/protected/v1/forms/${form.body.id}/fields`).set(t.authed(subA)).send(FIELDS).expect(200);
    await t.http().post(`/protected/v1/forms/${form.body.id}/publish`).set(t.authed(subA)).expect(201);
    await t.http().put(`/protected/v1/forms/${form.body.id}/fields`).set(t.authed(subA)).send(FIELDS).expect(409);
    await t.http().delete(`/protected/v1/forms/${form.body.id}`).set(t.authed(subA)).expect(409);
  });

  it("updates the title", async () => {
    const form = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "Old" }).expect(201);
    const res = await t.http().put(`/protected/v1/forms/${form.body.id}`).set(t.authed(subA)).send({ title: "New" }).expect(200);
    expect(res.body.title).toBe("New");
  });

  it("deletes a draft form", async () => {
    const form = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "Gone" }).expect(201);
    await t.http().delete(`/protected/v1/forms/${form.body.id}`).set(t.authed(subA)).expect(204);
    await t.http().get(`/protected/v1/forms/${form.body.id}`).set(t.authed(subA)).expect(404);
  });

  it("returns 404 for another tenant's form (RLS through the API)", async () => {
    const form = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "Mine" }).expect(201);
    await t.http().get(`/protected/v1/forms/${form.body.id}`).set(t.authed(subB)).expect(404);
    await t.http().put(`/protected/v1/forms/${form.body.id}`).set(t.authed(subB)).send({ title: "x" }).expect(404);
    await t.http().delete(`/protected/v1/forms/${form.body.id}`).set(t.authed(subB)).expect(404);
  });

  it("rejects duplicate field labels", async () => {
    const form = await t.http().post("/protected/v1/forms").set(t.authed(subA)).send({ title: "Dup" }).expect(201);
    await t.http()
      .put(`/protected/v1/forms/${form.body.id}/fields`)
      .set(t.authed(subA))
      .send({
        fields: [
          { type: "text", label: "Same", required: false },
          { type: "text", label: "Same", required: false },
        ],
      })
      .expect(400);
  });

  it("returns 400 for a non-uuid form id", async () => {
    await t.http().get("/protected/v1/forms/not-a-uuid").set(t.authed(subA)).expect(400);
  });
});
