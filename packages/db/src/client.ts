import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 });
}

/**
 * Run `fn` inside a transaction with `app.tenant_id` set via set_config(...,
 * is_local = true), so RLS policies scope every query to the tenant and the
 * setting vanishes on COMMIT/ROLLBACK.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: Db, client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const db = drizzle(client, { schema });
    const result = await fn(db, client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK itself failed (e.g. broken connection). The original error
      // is still the one callers care about — swallow this secondary failure
      // so we re-throw the original below.
    }
    throw err;
  } finally {
    client.release();
  }
}
