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
    const res = await this.pool.query(
      `INSERT INTO tenants (name, cognito_sub) VALUES ($1, $2)
       ON CONFLICT (cognito_sub) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub
       RETURNING id, name`,
      [sub, sub],
    );
    return res.rows[0];
  }
}
