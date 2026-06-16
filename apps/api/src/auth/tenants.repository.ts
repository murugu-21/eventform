import type { Executor } from "@eventform/db";

export const TENANT_REPOSITORY = "TENANT_REPOSITORY";

export interface Tenant {
  id: string;
  name: string;
}

export interface TenantRepository {
  findBySub(x: Executor, sub: string): Promise<Tenant | undefined>;
  /** INSERT ... ON CONFLICT DO UPDATE — race-safe first-login provisioning. */
  insertBySub(x: Executor, sub: string): Promise<Tenant>;
  updateName(x: Executor, tenantId: string, name: string): Promise<Tenant>;
}
