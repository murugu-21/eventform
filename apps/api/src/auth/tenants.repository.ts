export const TENANT_REPOSITORY = "TENANT_REPOSITORY";

export interface Tenant {
  id: string;
  name: string;
}

export interface TenantRepository {
  findBySub(sub: string): Promise<Tenant | undefined>;
  /** INSERT ... ON CONFLICT DO UPDATE — race-safe first-login provisioning. */
  insertBySub(sub: string): Promise<Tenant>;
  updateName(tenantId: string, name: string): Promise<Tenant>;
}
