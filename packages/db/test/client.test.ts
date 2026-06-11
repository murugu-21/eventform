import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPool, withTenant } from "../src/client";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";

describe("withTenant", () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = createPool(ADMIN_URL);
    const res = await pool.query(
      "INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2) RETURNING id",
      ["client-test", `sub-${randomUUID()}`],
    );
    tenantId = res.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("sets app.tenant_id for the duration of the transaction", async () => {
    const setting = await withTenant(pool, tenantId, async (_db, client) => {
      const res = await client.query("SELECT current_setting('app.tenant_id', true) AS t");
      return res.rows[0].t;
    });
    expect(setting).toBe(tenantId);
  });

  it("clears app.tenant_id after the transaction (SET LOCAL semantics)", async () => {
    const txPid = await withTenant(pool, tenantId, async (_db, client) => {
      const res = await client.query("SELECT pg_backend_pid() AS pid");
      return res.rows[0].pid as number;
    });

    const client = await pool.connect();
    try {
      const res = await client.query(
        "SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id', true) AS t",
      );
      expect(res.rows[0].pid).toBe(txPid); // same physical connection, or this test proves nothing
      expect(res.rows[0].t === null || res.rows[0].t === "").toBe(true);
    } finally {
      client.release();
    }
  });

  it("rolls back the transaction when the callback throws", async () => {
    const slug = `rollback-${randomUUID()}`;
    await expect(
      withTenant(pool, tenantId, async (_db, client) => {
        await client.query(
          "INSERT INTO forms (tenant_id, title, public_slug) VALUES ($1, $2, $3)",
          [tenantId, "doomed", slug],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const res = await pool.query("SELECT 1 FROM forms WHERE public_slug = $1", [slug]);
    expect(res.rowCount).toBe(0);
  });

  it("returns the callback result on commit", async () => {
    const result = await withTenant(pool, tenantId, async () => 42);
    expect(result).toBe(42);
  });
});
