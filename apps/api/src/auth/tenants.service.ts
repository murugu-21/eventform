import { Inject, Injectable } from "@nestjs/common";
import { Pool } from "pg";
import { poolExecutor } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { TENANT_REPOSITORY, Tenant, TenantRepository } from "./tenants.repository";

export type { Tenant } from "./tenants.repository";

@Injectable()
export class TenantsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(TENANT_REPOSITORY) private readonly repo: TenantRepository,
  ) {}

  async findOrCreateBySub(sub: string): Promise<Tenant> {
    const x = poolExecutor(this.pool);
    const existing = await this.repo.findBySub(x, sub);
    if (existing) {
      return existing;
    }
    return this.repo.insertBySub(x, sub);
  }

  /** Display-name update (e.g. from the Google ID token after first login). */
  async updateName(tenantId: string, name: string): Promise<Tenant> {
    return this.repo.updateName(poolExecutor(this.pool), tenantId, name);
  }
}
