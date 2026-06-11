import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { deliveries, endpoints, outbox, submissions, withTenant } from "@eventform/db";
import type { SubmissionReceivedEvent } from "@eventform/shared";
import { API_POOL } from "../db/db.module";

export interface PublicField {
  id: string;
  type: "text" | "multiple_choice";
  label: string;
  options: string[] | null;
  required: boolean;
  position: number;
}

export interface PublicForm {
  id: string;
  title: string;
  slug: string;
  fields: PublicField[];
}

/** Internal shape — includes tenantId for the submit path; never returned by controllers. */
export interface ResolvedForm extends PublicForm {
  tenantId: string;
}

@Injectable()
export class PublicService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  /** Anonymous read — RLS public-read policies scope to published forms. */
  async resolvePublishedForm(slug: string): Promise<ResolvedForm> {
    const form = await this.pool.query(
      `SELECT id, tenant_id, title, public_slug FROM forms WHERE public_slug = $1`,
      [slug],
    );
    if (form.rowCount !== 1) {
      throw new NotFoundException("form not found");
    }
    const fields = await this.pool.query(
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

  toPublicForm(resolved: ResolvedForm): PublicForm {
    const { tenantId: _omitted, ...pub } = resolved;
    return pub;
  }

  /**
   * Pure persistence: input validation (400s) happens upstream in the zod
   * pipe + AnswersValidationInterceptor. This method only writes the atomic
   * submission + deliveries + outbox set for an already-validated form.
   */
  async submit(
    form: ResolvedForm,
    answers: Record<string, string>,
    sourceIp: string | undefined,
  ): Promise<{ submissionId: string }> {
    const submittedAt = new Date();

    return withTenant(this.pool, form.tenantId, async (db) => {
      const [submission] = await db
        .insert(submissions)
        .values({ formId: form.id, tenantId: form.tenantId, answers, sourceIp, submittedAt })
        .returning();

      const activeEndpoints = await db
        .select()
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, form.tenantId), eq(endpoints.active, true)));

      for (const endpoint of activeEndpoints) {
        const deliveryId = randomUUID();
        const eventId = randomUUID();
        const payload: SubmissionReceivedEvent = {
          eventId,
          type: "submission.received",
          attempt: 1,
          tenantId: form.tenantId,
          formId: form.id,
          formTitle: form.title,
          submissionId: submission.id,
          endpointId: endpoint.id,
          deliveryId,
          answers,
          submittedAt: submittedAt.toISOString(),
        };
        await db.insert(deliveries).values({
          id: deliveryId,
          tenantId: form.tenantId,
          endpointId: endpoint.id,
          submissionId: submission.id,
          eventId,
        });
        await db.insert(outbox).values({
          id: eventId,
          tenantId: form.tenantId,
          aggregateType: "delivery",
          aggregateId: deliveryId,
          eventType: "submission.received",
          payload,
        });
      }
      return { submissionId: submission.id };
    });
  }
}
