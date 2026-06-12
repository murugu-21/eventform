import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { and, asc, desc, eq, SQL } from "drizzle-orm";
import { deliveries, deliveryAttempts, endpoints, outbox, withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { ListDeliveriesQuery } from "./deliveries.schemas";

@Injectable()
export class DeliveriesService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  list(tenantId: string, query: ListDeliveriesQuery) {
    return withTenant(this.pool, tenantId, async (db) => {
      const conditions: SQL[] = [eq(deliveries.tenantId, tenantId)];
      if (query.status) {
        conditions.push(eq(deliveries.status, query.status));
      }
      if (query.endpointId) {
        conditions.push(eq(deliveries.endpointId, query.endpointId));
      }
      const rows = await db
        .select({
          id: deliveries.id,
          endpointId: deliveries.endpointId,
          endpointName: endpoints.name,
          payload: deliveries.payload,
          status: deliveries.status,
          attemptCount: deliveries.attemptCount,
          nextRetryAt: deliveries.nextRetryAt,
          lastError: deliveries.lastError,
          responseCode: deliveries.responseCode,
          deliveredAt: deliveries.deliveredAt,
          createdAt: deliveries.createdAt,
        })
        .from(deliveries)
        .innerJoin(endpoints, eq(endpoints.id, deliveries.endpointId))
        .where(and(...conditions))
        .orderBy(desc(deliveries.createdAt))
        .limit(200);
      return rows;
    });
  }

  getWithAttempts(tenantId: string, id: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, id));
      if (!delivery) {
        throw new NotFoundException("delivery not found");
      }
      const attempts = await db
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, id))
        .orderBy(asc(deliveryAttempts.attemptNo));
      // delivery.payload is the event body as last emitted — durable on the
      // row itself (outbox rows are pruned, so they can't serve historical
      // reads), so no joins back into producer tables are needed.
      return { ...delivery, attempts };
    });
  }

  /** Manual retry: failed-only, FOR UPDATE, reset budget, re-emit through the outbox. */
  retry(tenantId: string, id: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [delivery] = await db
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, id))
        .for("update");
      if (!delivery) {
        throw new NotFoundException("delivery not found");
      }
      if (delivery.status !== "failed") {
        throw new ConflictException("only failed deliveries can be retried");
      }

      // Re-emit from the stored payload. The machinery only rewrites the
      // envelope fields it owns (eventId, attempt); the body stays whatever
      // the producer originally supplied.
      const eventId = randomUUID();
      const payload = { ...delivery.payload, eventId, attempt: 1 };
      await db.insert(outbox).values({
        id: eventId,
        tenantId,
        aggregateType: "delivery",
        aggregateId: delivery.id,
        eventType: String(delivery.payload.type ?? "unknown"),
        payload,
      });
      const [updated] = await db
        .update(deliveries)
        .set({
          status: "pending",
          attemptCount: 0,
          payload,
          eventId,
          nextRetryAt: null,
          lastError: null,
          responseCode: null,
        })
        .where(eq(deliveries.id, id))
        .returning();
      return updated;
    });
  }
}
