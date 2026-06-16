import { Inject, Injectable } from "@nestjs/common";
import { Pool } from "pg";
import type { Executor } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { Tenant, TenantRepository } from "./tenants.repository";

@Injectable()
export class DrizzleTenantRepository implements TenantRepository {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async findBySub(_x: Executor, sub: string): Promise<Tenant | undefined> {
    const res = await this.pool.query("SELECT id, name FROM tenants WHERE cognito_sub = $1", [sub]);
    return res.rowCount === 1 ? (res.rows[0] as Tenant) : undefined;
  }

  async insertBySub(_x: Executor, sub: string): Promise<Tenant> {
    const res = await this.pool.query(
      `INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2)
       ON CONFLICT (cognito_sub) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub
       RETURNING id, name`,
      [sub, sub],
    );
    return res.rows[0] as Tenant;
  }

  async updateName(_x: Executor, tenantId: string, name: string): Promise<Tenant> {
    const res = await this.pool.query(
      "UPDATE tenants SET name = $2 WHERE id = $1 RETURNING id, name",
      [tenantId, name],
    );
    return res.rows[0] as Tenant;
  }
}
