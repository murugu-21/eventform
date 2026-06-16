import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { buildSubmissionReceivedEvent } from "../domain/submission-event";
import { PUBLIC_REPOSITORY, PublicFormRecord, PublicRepository } from "./public.repository";

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

export interface ResolvedForm extends PublicForm {
  tenantId: string;
}

@Injectable()
export class PublicService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(PUBLIC_REPOSITORY) private readonly repo: PublicRepository,
  ) {}

  /** Anonymous read — RLS public-read policies scope to published forms. */
  async resolvePublishedForm(slug: string): Promise<ResolvedForm> {
    const record = await this.repo.findPublishedFormBySlug(slug);
    if (!record) {
      throw new NotFoundException("form not found");
    }
    return record as PublicFormRecord & ResolvedForm;
  }

  toPublicForm(resolved: ResolvedForm): PublicForm {
    const { tenantId: _omitted, ...pub } = resolved;
    return pub;
  }

  async submit(
    form: ResolvedForm,
    answers: Record<string, string>,
    sourceIp: string | undefined,
  ): Promise<{ submissionId: string }> {
    const submittedAt = new Date();
    return withTenant(this.pool, form.tenantId, async (db) => {
      const submissionId = await this.repo.insertSubmission(db, {
        formId: form.id,
        tenantId: form.tenantId,
        answers,
        sourceIp,
        submittedAt,
      });

      const endpointIds = await this.repo.listActiveEndpointIds(db, form.tenantId);
      for (const endpointId of endpointIds) {
        const { deliveryId, eventId, payload } = buildSubmissionReceivedEvent({
          tenantId: form.tenantId,
          formId: form.id,
          formTitle: form.title,
          submissionId,
          endpointId,
          answers,
          submittedAt,
        });
        await this.repo.insertDeliveryWithOutbox(db, form.tenantId, {
          deliveryId,
          endpointId,
          eventId,
          payload,
        });
      }
      return { submissionId };
    });
  }
}
