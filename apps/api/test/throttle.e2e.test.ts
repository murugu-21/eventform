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
      await t.http().post(`/v1/forms/${form.publicSlug}`).send(answers).expect(201);
    }
    await t.http().post(`/v1/forms/${form.publicSlug}`).send(answers).expect(429);
  });
});
