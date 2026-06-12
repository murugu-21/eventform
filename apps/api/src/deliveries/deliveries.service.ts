import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { and, asc, desc, eq, SQL } from "drizzle-orm";
import {
  deliveries,
  deliveryAttempts,
  endpoints,
  forms,
  outbox,
  submissions,
  withTenant,
} from "@eventform/db";
import type { SubmissionReceivedEvent } from "@eventform/shared";
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
          submissionId: deliveries.submissionId,
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

      // The webhook payload, reconstructed from durable rows the same way the
      // retry path builds it (outbox rows are pruned, so they can't serve
      // historical reads). `attempt` reflects the last attempt actually sent.
      const [submission] = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, delivery.submissionId));
      const [form] = await db.select().from(forms).where(eq(forms.id, submission.formId));
      const payload: SubmissionReceivedEvent = {
        eventId: delivery.eventId,
        type: "submission.received",
        attempt: Math.max(delivery.attemptCount, 1),
        tenantId,
        formId: form.id,
        formTitle: form.title,
        submissionId: submission.id,
        endpointId: delivery.endpointId,
        deliveryId: delivery.id,
        answers: submission.answers,
        submittedAt: submission.submittedAt.toISOString(),
      };
      return { ...delivery, attempts, payload };
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

      const [submission] = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, delivery.submissionId));
      const [form] = await db.select().from(forms).where(eq(forms.id, submission.formId));
      const eventId = randomUUID();
      const payload: SubmissionReceivedEvent = {
        eventId,
        type: "submission.received",
        attempt: 1,
        tenantId,
        formId: form.id,
        formTitle: form.title,
        submissionId: submission.id,
        endpointId: delivery.endpointId,
        deliveryId: delivery.id,
        answers: submission.answers,
        submittedAt: submission.submittedAt.toISOString(),
      };
      await db.insert(outbox).values({
        id: eventId,
        tenantId,
        aggregateType: "delivery",
        aggregateId: delivery.id,
        eventType: "submission.received",
        payload,
      });
      const [updated] = await db
        .update(deliveries)
        .set({
          status: "pending",
          attemptCount: 0,
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
