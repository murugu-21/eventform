import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { desc, eq } from "drizzle-orm";
import { forms, submissions, withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";

@Injectable()
export class SubmissionsService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

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
