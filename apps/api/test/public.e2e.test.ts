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
