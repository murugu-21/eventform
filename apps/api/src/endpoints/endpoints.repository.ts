import type { Executor } from "@eventform/db";
import { endpoints } from "@eventform/db";

export const ENDPOINT_REPOSITORY = "ENDPOINT_REPOSITORY";

export type EndpointRow = typeof endpoints.$inferSelect;

export interface EndpointRepository {
  countByTenant(x: Executor, tenantId: string): Promise<number>;
  insert(
    x: Executor,
    values: { tenantId: string; name: string; url: string; secretCiphertext: string },
  ): Promise<EndpointRow>;
  listByTenant(x: Executor): Promise<EndpointRow[]>;
  findById(x: Executor, id: string, tenantId: string): Promise<EndpointRow | undefined>;
  update(
    x: Executor,
    id: string,
    tenantId: string,
    patch: Partial<{ name: string; url: string; active: boolean }>,
  ): Promise<EndpointRow | undefined>;
  updateSecret(
    x: Executor,
    id: string,
    tenantId: string,
    secretCiphertext: string,
  ): Promise<EndpointRow | undefined>;
  remove(x: Executor, id: string, tenantId: string): Promise<EndpointRow | undefined>;
}
