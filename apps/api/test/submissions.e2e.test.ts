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
    await t.http().post(`/v1/forms/${form.publicSlug}`).send({ answers: { "Your name": "First" } }).expect(201);
    await t.http().post(`/v1/forms/${form.publicSlug}`).send({ answers: { "Your name": "Second" } }).expect(201);

    const res = await t.http().get(`/protected/v1/forms/${form.id}/submissions`).set(t.authed(subA)).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].answers["Your name"]).toBe("Second");
    expect(res.body[1].answers["Your name"]).toBe("First");
  });

  it("lists all responses across forms with titles, tenant-isolated", async () => {
    const formA = await publishForm(t, subA, "Global A");
    const formB = await publishForm(t, subA, "Global B");
    await t.http().post(`/v1/forms/${formA.publicSlug}`).send({ answers: { "Your name": "From A" } }).expect(201);
    await t.http().post(`/v1/forms/${formB.publicSlug}`).send({ answers: { "Your name": "From B" } }).expect(201);

    const res = await t.http().get("/protected/v1/submissions").set(t.authed(subA)).expect(200);
    const titles = res.body.map((r: { formTitle: string }) => r.formTitle);
    expect(titles).toContain("Global A");
    expect(titles).toContain("Global B");
    expect(new Date(res.body[0].submittedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(res.body[res.body.length - 1].submittedAt).getTime(),
    );

    const other = await t.http().get("/protected/v1/submissions").set(t.authed(subB)).expect(200);
    expect(other.body.some((r: { formTitle: string }) => r.formTitle.startsWith("Global"))).toBe(false);
  });

  it("404s for another tenant's form", async () => {
    const form = await publishForm(t, subA, "Iso subs");
    await t.http().get(`/protected/v1/forms/${form.id}/submissions`).set(t.authed(subB)).expect(404);
  });
});
