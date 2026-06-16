import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, SQL } from "drizzle-orm";
import { deliveries, deliveryAttempts, endpoints, outbox, type Executor } from "@eventform/db";
import type { ListDeliveriesQuery } from "./deliveries.schemas";
import {
  DeliveryAttemptRow,
  DeliveryListItem,
  DeliveryRepository,
  DeliveryRow,
} from "./deliveries.repository";

@Injectable()
export class DrizzleDeliveryRepository implements DeliveryRepository {
  list(x: Executor, tenantId: string, query: ListDeliveriesQuery): Promise<DeliveryListItem[]> {
    const conditions: SQL[] = [eq(deliveries.tenantId, tenantId)];
    if (query.status) {
      conditions.push(eq(deliveries.status, query.status));
    }
    if (query.endpointId) {
      conditions.push(eq(deliveries.endpointId, query.endpointId));
    }
    return x
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
  }

  async findById(x: Executor, id: string): Promise<DeliveryRow | undefined> {
    const [delivery] = await x.select().from(deliveries).where(eq(deliveries.id, id));
    return delivery;
  }

  listAttempts(x: Executor, deliveryId: string): Promise<DeliveryAttemptRow[]> {
    return x
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, deliveryId))
      .orderBy(asc(deliveryAttempts.attemptNo));
  }

  async findByIdForUpdate(x: Executor, id: string): Promise<DeliveryRow | undefined> {
    const [delivery] = await x.select().from(deliveries).where(eq(deliveries.id, id)).for("update");
    return delivery;
  }

  async reEmitRetry(
    x: Executor,
    args: { delivery: DeliveryRow; tenantId: string; eventId: string; payload: DeliveryRow["payload"] },
  ): Promise<DeliveryRow> {
    const { delivery, tenantId, eventId, payload } = args;
    await x.insert(outbox).values({
      id: eventId,
      tenantId,
      aggregateType: "delivery",
      aggregateId: delivery.id,
      eventType: String((delivery.payload as Record<string, unknown>).type ?? "unknown"),
      payload,
    });
    const [updated] = await x
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
      .where(eq(deliveries.id, delivery.id))
      .returning();
    return updated;
  }
}
