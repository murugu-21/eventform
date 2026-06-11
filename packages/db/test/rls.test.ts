import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { createPool, withTenant } from "../src/client";
import { forms } from "../src/schema";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform";
const API_URL =
  process.env.DATABASE_URL_API ??
  "postgres://app_api:app_api_dev@localhost:5432/eventform";

describe("row-level security", () => {
  let adminPool: Pool;
  let apiPool: Pool;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    adminPool = createPool(ADMIN_URL);
    apiPool = createPool(API_URL);
    const a = await adminPool.query(
      "INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2) RETURNING id",
      ["rls-tenant-a", `sub-${randomUUID()}`],
    );
    const b = await adminPool.query(
      "INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2) RETURNING id",
      ["rls-tenant-b", `sub-${randomUUID()}`],
    );
    tenantA = a.rows[0].id;
    tenantB = b.rows[0].id;
  });

  afterAll(async () => {
    await adminPool.end();
    await apiPool.end();
  });

  it("hides tenant A's draft forms from tenant B", async () => {
    const slug = `rls-draft-${randomUUID()}`;
    await withTenant(apiPool, tenantA, (db) =>
      db.insert(forms).values({ tenantId: tenantA, title: "A draft", publicSlug: slug }),
    );

    const seenByB = await withTenant(apiPool, tenantB, (db) =>
      db.select().from(forms).where(eq(forms.publicSlug, slug)),
    );
    expect(seenByB).toHaveLength(0);

    const seenByA = await withTenant(apiPool, tenantA, (db) =>
      db.select().from(forms).where(eq(forms.publicSlug, slug)),
    );
    expect(seenByA).toHaveLength(1);
  });

  it("rejects inserting a row for another tenant (WITH CHECK)", async () => {
    // Drizzle wraps the pg error in DrizzleQueryError; the original RLS message
    // lives on .cause.message, so we catch and inspect the error chain.
    let thrown: unknown;
    try {
      await withTenant(apiPool, tenantA, (db) =>
        db.insert(forms).values({
          tenantId: tenantB,
          title: "forged",
          publicSlug: `rls-forged-${randomUUID()}`,
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const cause = (thrown as { cause?: { message?: string } }).cause;
    expect(cause?.message).toMatch(/row-level security/);
  });

  it("rejects cross-tenant updates (rows invisible)", async () => {
    const slug = `rls-update-${randomUUID()}`;
    await withTenant(apiPool, tenantA, (db) =>
      db.insert(forms).values({ tenantId: tenantA, title: "mine", publicSlug: slug }),
    );

    const updated = await withTenant(apiPool, tenantB, (db) =>
      db.update(forms).set({ title: "hijacked" }).where(eq(forms.publicSlug, slug)).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it("allows anonymous (no tenant set) reads of published forms only", async () => {
    const draftSlug = `rls-anon-draft-${randomUUID()}`;
    const publishedSlug = `rls-anon-pub-${randomUUID()}`;
    await withTenant(apiPool, tenantA, async (db) => {
      await db.insert(forms).values({ tenantId: tenantA, title: "draft", publicSlug: draftSlug });
      await db.insert(forms).values({
        tenantId: tenantA,
        title: "published",
        status: "published",
        publicSlug: publishedSlug,
      });
    });

    const client = await apiPool.connect();
    try {
      const pub = await client.query("SELECT id FROM forms WHERE public_slug = $1", [
        publishedSlug,
      ]);
      expect(pub.rowCount).toBe(1);

      const draft = await client.query("SELECT id FROM forms WHERE public_slug = $1", [
        draftSlug,
      ]);
      expect(draft.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it("lets the admin (table owner) see all tenants' rows", async () => {
    const slug = `rls-admin-${randomUUID()}`;
    await withTenant(apiPool, tenantA, (db) =>
      db.insert(forms).values({ tenantId: tenantA, title: "visible to admin", publicSlug: slug }),
    );
    const res = await adminPool.query("SELECT 1 FROM forms WHERE public_slug = $1", [slug]);
    expect(res.rowCount).toBe(1);
  });
});
