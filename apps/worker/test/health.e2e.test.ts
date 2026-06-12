import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { HealthController } from "../src/health.controller";

// Boots ONLY the health controller — not AppModule — so this deterministic
// test never starts the Kafka consumer or schedulers. The full pipeline
// (outbox → Debezium → Kafka → worker → webhook) is covered by pipeline.e2e
// (run via `pnpm test:pipeline`) and by the Playwright smoke in CI.
describe("GET /health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns ok without auth", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
