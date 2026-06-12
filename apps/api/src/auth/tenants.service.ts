import { Inject, Injectable } from "@nestjs/common";
import { Pool } from "pg";
import { API_POOL } from "../db/db.module";

export interface Tenant {
  id: string;
  name: string;
}

@Injectable()
export class TenantsService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async findOrCreateBySub(sub: string): Promise<Tenant> {
    const existing = await this.pool.query(
      "SELECT id, name FROM tenants WHERE cognito_sub = $1",
      [sub],
    );
    if (existing.rowCount === 1) {
      return existing.rows[0];
    }
    // INSERT with a no-op DO UPDATE guards the concurrent-first-login race:
    // if two requests arrive simultaneously for a new sub, the loser of the
    // INSERT still returns a row rather than silently discarding it.
    const res = await this.pool.query(
      `INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2)
       ON CONFLICT (cognito_sub) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub
       RETURNING id, name`,
      [sub, sub],
    );
    return res.rows[0];
  }

  /** Display-name update (e.g. from the Google ID token after first login). */
  async updateName(tenantId: string, name: string): Promise<Tenant> {
    const res = await this.pool.query(
      "UPDATE tenants SET name = $2 WHERE id = $1 RETURNING id, name",
      [tenantId, name],
    );
    return res.rows[0];
  }
}
