import { Inject, Injectable } from "@nestjs/common";
import { TENANT_REPOSITORY, Tenant, TenantRepository } from "./tenants.repository";

export type { Tenant } from "./tenants.repository";

@Injectable()
export class TenantsService {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly repo: TenantRepository,
  ) {}

  async findOrCreateBySub(sub: string): Promise<Tenant> {
    const existing = await this.repo.findBySub(sub);
    if (existing) {
      return existing;
    }
    return this.repo.insertBySub(sub);
  }

  /** Display-name update (e.g. from the Google ID token after first login). */
  async updateName(tenantId: string, name: string): Promise<Tenant> {
    return this.repo.updateName(tenantId, name);
  }
}
