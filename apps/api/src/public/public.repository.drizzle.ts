import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { deliveries, endpoints, outbox, submissions, type Executor } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { DeliveryWrite, PublicFormRecord, PublicRepository } from "./public.repository";

@Injectable()
export class DrizzlePublicRepository implements PublicRepository {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async findPublishedFormBySlug(_x: Executor, slug: string): Promise<PublicFormRecord | null> {
    // Raw SQL preserves the exact anonymous read the service used (RLS public
    // policies apply because no app.tenant_id is set on a pool executor).
    // The pool executor passed in (_x) is pool-bound; using the underlying pool
    // directly keeps the read off any tenant transaction.
    const session = this.pool;
    const form = await session.query(
      `SELECT id, tenant_id, title, public_slug FROM forms WHERE public_slug = $1`,
      [slug],
    );
    if (form.rowCount !== 1) {
      return null;
    }
    const fields = await session.query(
      `SELECT id, type, label, options, required, position
       FROM form_fields WHERE form_id = $1 ORDER BY position`,
      [form.rows[0].id],
    );
    return {
      id: form.rows[0].id,
      tenantId: form.rows[0].tenant_id,
      title: form.rows[0].title,
      slug: form.rows[0].public_slug,
      fields: fields.rows,
    };
  }

  async listActiveEndpointIds(x: Executor, tenantId: string): Promise<string[]> {
    const rows = await x
      .select({ id: endpoints.id })
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.active, true)));
    return rows.map((r) => r.id);
  }

  async insertSubmission(
    x: Executor,
    row: { formId: string; tenantId: string; answers: Record<string, string>; sourceIp: string | undefined; submittedAt: Date },
  ): Promise<string> {
    const [submission] = await x.insert(submissions).values(row).returning();
    return submission.id;
  }

  async insertDeliveryWithOutbox(x: Executor, tenantId: string, write: DeliveryWrite): Promise<void> {
    await x.insert(deliveries).values({
      id: write.deliveryId,
      tenantId,
      endpointId: write.endpointId,
      payload: write.payload,
      eventId: write.eventId,
    });
    await x.insert(outbox).values({
      id: write.eventId,
      tenantId,
      aggregateType: "delivery",
      aggregateId: write.deliveryId,
      eventType: "submission.received",
      payload: write.payload,
    });
  }
}
