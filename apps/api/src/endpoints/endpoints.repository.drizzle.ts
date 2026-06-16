import { Injectable } from "@nestjs/common";
import { and, asc, count, eq } from "drizzle-orm";
import { endpoints, type Executor } from "@eventform/db";
import { EndpointRepository, EndpointRow } from "./endpoints.repository";

@Injectable()
export class DrizzleEndpointRepository implements EndpointRepository {
  async countByTenant(x: Executor, tenantId: string): Promise<number> {
    const [{ value }] = await x
      .select({ value: count() })
      .from(endpoints)
      .where(eq(endpoints.tenantId, tenantId));
    return value;
  }

  async insert(
    x: Executor,
    values: { tenantId: string; name: string; url: string; secretCiphertext: string },
  ): Promise<EndpointRow> {
    const [created] = await x.insert(endpoints).values(values).returning();
    return created;
  }

  listByTenant(x: Executor): Promise<EndpointRow[]> {
    return x.select().from(endpoints).orderBy(asc(endpoints.createdAt));
  }

  async findById(x: Executor, id: string, tenantId: string): Promise<EndpointRow | undefined> {
    const [found] = await x
      .select()
      .from(endpoints)
      .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)));
    return found;
  }

  async update(
    x: Executor,
    id: string,
    tenantId: string,
    patch: Partial<{ name: string; url: string; active: boolean }>,
  ): Promise<EndpointRow | undefined> {
    const [updated] = await x
      .update(endpoints)
      .set(patch)
      .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)))
      .returning();
    return updated;
  }

  async updateSecret(
    x: Executor,
    id: string,
    tenantId: string,
    secretCiphertext: string,
  ): Promise<EndpointRow | undefined> {
    const [updated] = await x
      .update(endpoints)
      .set({ secretCiphertext })
      .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)))
      .returning();
    return updated;
  }

  async remove(x: Executor, id: string, tenantId: string): Promise<EndpointRow | undefined> {
    const [removed] = await x
      .delete(endpoints)
      .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)))
      .returning();
    return removed;
  }
}
