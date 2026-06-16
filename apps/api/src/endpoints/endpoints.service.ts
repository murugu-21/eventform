import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { generateEndpointSecret, SecretCipher } from "@eventform/shared";
import { API_POOL, SECRET_CIPHER } from "../db/db.module";
import { CreateEndpointDto, UpdateEndpointDto } from "./endpoints.schemas";
import { ENDPOINT_REPOSITORY, EndpointRepository, EndpointRow } from "./endpoints.repository";

function publicView(row: EndpointRow) {
  const { secretCiphertext: _omitted, ...rest } = row;
  return rest;
}

@Injectable()
export class EndpointsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
    @Inject(ENDPOINT_REPOSITORY) private readonly repo: EndpointRepository,
  ) {}

  async create(tenantId: string, dto: CreateEndpointDto) {
    const secret = generateEndpointSecret();
    const secretCiphertext = await this.cipher.encrypt(secret, tenantId);
    const row = await withTenant(this.pool, tenantId, async (db) => {
      // Cap endpoints at 20 per tenant.
      const existing = await this.repo.countByTenant(db, tenantId);
      if (existing >= 20) {
        throw new ConflictException("endpoint limit reached (20)");
      }
      return this.repo.insert(db, { tenantId, name: dto.name, url: dto.url, secretCiphertext });
    });
    return { ...publicView(row), secret };
  }

  list(tenantId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const rows = await this.repo.listByTenant(db);
      return rows.map(publicView);
    });
  }

  async update(tenantId: string, id: string, dto: UpdateEndpointDto) {
    const row = await withTenant(this.pool, tenantId, (db) =>
      this.repo.update(db, id, tenantId, dto),
    );
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    return publicView(row);
  }

  async remove(tenantId: string, id: string) {
    const removed = await withTenant(this.pool, tenantId, (db) =>
      this.repo.remove(db, id, tenantId),
    );
    if (!removed) {
      throw new NotFoundException("endpoint not found");
    }
  }

  async revealSecret(tenantId: string, id: string) {
    const row = await withTenant(this.pool, tenantId, (db) =>
      this.repo.findById(db, id, tenantId),
    );
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    const secret = await this.cipher.decrypt(row.secretCiphertext, tenantId);
    return { secret };
  }

  async rotateSecret(tenantId: string, id: string) {
    const secret = generateEndpointSecret();
    const secretCiphertext = await this.cipher.encrypt(secret, tenantId);
    const row = await withTenant(this.pool, tenantId, (db) =>
      this.repo.updateSecret(db, id, tenantId, secretCiphertext),
    );
    if (!row) {
      throw new NotFoundException("endpoint not found");
    }
    return { ...publicView(row), secret };
  }
}
