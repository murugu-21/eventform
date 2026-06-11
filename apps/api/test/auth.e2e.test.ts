import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createPool } from "@eventform/db";
import { AppModule } from "../src/app.module";
import { loadConfig } from "../src/config";

describe("auth", () => {
  let app: INestApplication;
  let adminPool: Pool;
  const sub = `auth-e2e-${randomUUID()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    adminPool = createPool(loadConfig().databaseUrlAdmin);
  });

  afterAll(async () => {
    await adminPool.query("DELETE FROM tenants WHERE cognito_sub = $1", [sub]);
    await adminPool.end();
    await app.close();
  });

  it("rejects requests without a bearer token", async () => {
    await request(app.getHttpServer()).get("/me").expect(401);
  });

  it("rejects malformed dev tokens", async () => {
    const bad = [
      "Bearer dev_!!bad!!",
      "Bearer not-a-dev-token",
      "Bearer ",
      "Bearer dev_",
      "bearer dev_x",
      `Bearer dev_${"a".repeat(65)}`,
    ];
    for (const header of bad) {
      await request(app.getHttpServer()).get("/me").set("Authorization", header).expect(401);
    }
  });

  it("provisions a tenant on first valid request and returns it", async () => {
    const res = await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", `Bearer dev_${sub}`)
      .expect(200);
    expect(res.body.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.name).toBe(sub);

    const row = await adminPool.query("SELECT id FROM tenants WHERE cognito_sub = $1", [sub]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].id).toBe(res.body.tenantId);
  });

  it("is idempotent — same sub maps to the same tenant", async () => {
    const a = await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", `Bearer dev_${sub}`)
      .expect(200);
    const b = await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", `Bearer dev_${sub}`)
      .expect(200);
    expect(a.body.tenantId).toBe(b.body.tenantId);
  });

  it("keeps /health public", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
  });
});
