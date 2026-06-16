import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { SUBMISSION_REPOSITORY, SubmissionRepository } from "./submissions.repository";

@Injectable()
export class SubmissionsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(SUBMISSION_REPOSITORY) private readonly repo: SubmissionRepository,
  ) {}

  /** All responses across the tenant's forms, newest first (latest 200). */
  listAll(tenantId: string) {
    return withTenant(this.pool, tenantId, (db) => this.repo.listAll(db));
  }

  listForForm(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      if (!(await this.repo.formExists(db, formId))) {
        throw new NotFoundException("form not found");
      }
      return this.repo.listForForm(db, formId);
    });
  }
}
