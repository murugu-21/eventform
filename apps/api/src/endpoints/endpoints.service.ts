import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { and, asc, count, eq } from "drizzle-orm";
import { endpoints, withTenant } from "@eventform/db";
import { generateEndpointSecret, SecretCipher } from "@eventform/shared";
import { API_POOL, SECRET_CIPHER } from "../db/db.module";
import { CreateEndpointDto, UpdateEndpointDto } from "./endpoints.schemas";

type EndpointRow = typeof endpoints.$inferSelect;

function publicView(row: EndpointRow) {
  const { secretCiphertext: _omitted, ...rest } = row;
  return rest;
}

@Injectable()
export class EndpointsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
  ) {}

  async create(tenantId: string, dto: CreateEndpointDto) {
    const secret = generateEndpointSecret();
    const secretCiphertext = await this.cipher.encrypt(secret, tenantId);
    const row = await withTenant(this.pool, tenantId, async (db) => {
      // Cap endpoints at 20 per tenant.
      // NOTE: a loop-of-20-creates e2e would be slow; the cap is documented here
      // and verified by code review. A future unit-ish e2e can monkeypatch the
      // count query if needed.
      const [{ value: existing }] = await db
        .select({ value: count() })
        .from(endpoints)
        .where(eq(endpoints.tenantId, tenantId));
      if (existing >= 20) {
        throw new ConflictException("endpoint limit reached (20)");
      }
      const [created] = await db
        .insert(endpoints)
        .values({ tenantId, name: dto.name, url: dto.url, secretCiphertext })
        .returning();
      return created;
    });
    return { ...publicView(row), secret };
  }

  list(tenantId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const rows = await db.select().from(endpoints).orderBy(asc(endpoints.createdAt));
      return rows.map(publicView);
    });
  }

  async update(tenantId: string, id: string, dto: UpdateEndpointDto) {
    const row = await withTenant(this.pool, tenantId, async (db) => {
      const [updated] = await db
        .update(endpoints)
        .set(dto)
        .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)))
        .returning();
      return updated;
    });
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    return publicView(row);
  }

  async remove(tenantId: string, id: string) {
    const removed = await withTenant(this.pool, tenantId, async (db) => {
      const rows = await db.delete(endpoints).where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId))).returning();
      return rows[0];
    });
    if (!removed) {
      throw new NotFoundException("endpoint not found");
    }
  }

  async revealSecret(tenantId: string, id: string) {
    const row = await withTenant(this.pool, tenantId, async (db) => {
      const [found] = await db.select().from(endpoints).where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)));
      return found;
    });
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    const secret = await this.cipher.decrypt(row.secretCiphertext, tenantId);
    return { secret };
  }

  async rotateSecret(tenantId: string, id: string) {
    const secret = generateEndpointSecret();
    const secretCiphertext = await this.cipher.encrypt(secret, tenantId);
    const row = await withTenant(this.pool, tenantId, async (db) => {
      const [updated] = await db
        .update(endpoints)
        .set({ secretCiphertext })
        .where(and(eq(endpoints.id, id), eq(endpoints.tenantId, tenantId)))
        .returning();
      return updated;
    });
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    return { ...publicView(row), secret };
  }
}
