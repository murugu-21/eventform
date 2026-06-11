import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Pool } from "pg";
import request from "supertest";
import { createPool } from "@eventform/db";
import { AppModule } from "../src/app.module";
import { loadConfig } from "../src/config";

export interface TestContext {
  app: INestApplication;
  adminPool: Pool;
  http: () => ReturnType<typeof request>;
  authed: (sub: string) => { Authorization: string };
  cleanupSubs: (subs: string[]) => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const adminPool = createPool(loadConfig().databaseUrlAdmin);

  return {
    app,
    adminPool,
    http: () => request(app.getHttpServer()),
    authed: (sub: string) => ({ Authorization: `Bearer dev_${sub}` }),
    cleanupSubs: async (subs: string[]) => {
      // delete in FK order; deliveries/submissions don't exist in 2a fixtures
      await adminPool.query(
        `DELETE FROM form_fields WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = ANY($1))`,
        [subs],
      );
      await adminPool.query(
        `DELETE FROM forms WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = ANY($1))`,
        [subs],
      );
      await adminPool.query(
        `DELETE FROM endpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE cognito_sub = ANY($1))`,
        [subs],
      );
      await adminPool.query(`DELETE FROM tenants WHERE cognito_sub = ANY($1)`, [subs]);
    },
    close: async () => {
      await adminPool.end();
      await app.close();
    },
  };
}

const PUBLISH_FIELDS = {
  fields: [
    { type: "text", label: "Your name", required: true },
    { type: "multiple_choice", label: "Rating", options: ["Good", "Bad"], required: false },
  ],
};

export async function publishForm(
  t: TestContext,
  sub: string,
  title = "Public form",
): Promise<{ id: string; publicSlug: string }> {
  const form = await t.http().post("/protected/v1/forms").set(t.authed(sub)).send({ title }).expect(201);
  await t.http().put(`/protected/v1/forms/${form.body.id}/fields`).set(t.authed(sub)).send(PUBLISH_FIELDS).expect(200);
  await t.http().post(`/protected/v1/forms/${form.body.id}/publish`).set(t.authed(sub)).expect(201);
  return form.body;
}
