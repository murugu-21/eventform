import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

/**
 * A query executor handed to repositories. It is just a Drizzle handle:
 * - tx-bound (from withTenant) for atomic, tenant-scoped work, or
 * - pool-bound (from poolExecutor) for anonymous reads under RLS public policies.
 * Repositories never open their own connection; the caller chooses the executor.
 */
export type Executor = Db;

let pooled: Db | undefined;

/**
 * A pool-bound Drizzle handle for non-transactional / anonymous reads (no
 * `SET LOCAL app.tenant_id`). Memoized per process. Each query borrows a pool
 * connection. Do NOT use for multi-statement atomic work — use withTenant.
 */
export function poolExecutor(pool: Pool): Db {
  if (!pooled) {
    pooled = drizzle(pool, { schema });
  }
  return pooled;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID_RE.test(tenantId)) {
    throw new Error(
      `withTenant: tenantId must be a UUID, got ${JSON.stringify(tenantId)}`,
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const db = drizzle(client, { schema });
    const result = await fn(db, client);
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch {
      // ROLLBACK failed on a still-open socket: the connection may be stuck
      // mid-transaction — hand the error to release() so pg-pool destroys it
      // instead of pooling a poisoned client.
      client.release(err as Error);
    }
    throw err;
  }
}
