import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
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
}
