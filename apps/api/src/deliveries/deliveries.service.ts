import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { ListDeliveriesQuery } from "./deliveries.schemas";
import { DELIVERY_REPOSITORY, DeliveryRepository } from "./deliveries.repository";

@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(DELIVERY_REPOSITORY) private readonly repo: DeliveryRepository,
  ) {}

  list(tenantId: string, query: ListDeliveriesQuery) {
    return withTenant(this.pool, tenantId, (db) => this.repo.list(db, tenantId, query));
  }

  getWithAttempts(tenantId: string, id: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const delivery = await this.repo.findById(db, id);
      if (!delivery) {
        throw new NotFoundException("delivery not found");
      }
      const attempts = await this.repo.listAttempts(db, id);
      return { ...delivery, attempts };
    });
  }

  /** Manual retry: failed-only, FOR UPDATE, reset budget, re-emit through the outbox. */
  retry(tenantId: string, id: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const delivery = await this.repo.findByIdForUpdate(db, id);
      if (!delivery) {
        throw new NotFoundException("delivery not found");
      }
      if (delivery.status !== "failed") {
        throw new ConflictException("only failed deliveries can be retried");
      }
      const eventId = randomUUID();
      const payload = { ...delivery.payload, eventId, attempt: 1 };
      return this.repo.reEmitRetry(db, { delivery, tenantId, eventId, payload });
    });
  }
}
