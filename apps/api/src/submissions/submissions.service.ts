import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { desc, eq } from "drizzle-orm";
import { forms, submissions, withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";

@Injectable()
export class SubmissionsService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  /** All responses across the tenant's forms, newest first (latest 200). */
  listAll(tenantId: string) {
    return withTenant(this.pool, tenantId, (db) =>
      db
        .select({
          id: submissions.id,
          formId: submissions.formId,
          formTitle: forms.title,
          answers: submissions.answers,
          submittedAt: submissions.submittedAt,
          sourceIp: submissions.sourceIp,
        })
        .from(submissions)
        .innerJoin(forms, eq(forms.id, submissions.formId))
        .orderBy(desc(submissions.submittedAt))
        .limit(200),
    );
  }

  listForForm(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId));
      if (!form) {
        throw new NotFoundException("form not found");
      }
      return db
        .select()
        .from(submissions)
        .where(eq(submissions.formId, formId))
        .orderBy(desc(submissions.submittedAt));
    });
  }
}
