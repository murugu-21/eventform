import { randomBytes } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { asc, eq } from "drizzle-orm";
import { formFields, forms, withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { CreateFormDto, ReplaceFieldsDto } from "./forms.schemas";

@Injectable()
export class FormsService {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  create(tenantId: string, dto: CreateFormDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db
        .insert(forms)
        .values({
          tenantId,
          title: dto.title,
          publicSlug: randomBytes(6).toString("base64url"),
        })
        .returning();
      return form;
    });
  }

  list(tenantId: string) {
    return withTenant(this.pool, tenantId, (db) =>
      db.select().from(forms).orderBy(asc(forms.createdAt)),
    );
  }

  async getWithFields(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId));
      if (!form) {
        throw new NotFoundException("form not found");
      }
      const fields = await db
        .select()
        .from(formFields)
        .where(eq(formFields.formId, formId))
        .orderBy(asc(formFields.position));
      return { ...form, fields };
    });
  }

  async updateTitle(tenantId: string, formId: string, dto: CreateFormDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db
        .update(forms)
        .set({ title: dto.title })
        .where(eq(forms.id, formId))
        .returning();
      if (!form) {
        throw new NotFoundException("form not found");
      }
      return form;
    });
  }

  async remove(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId)).for("update");
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("published forms cannot be deleted");
      }
      await db.delete(forms).where(eq(forms.id, formId)); // fields cascade
    });
  }

  async replaceFields(tenantId: string, formId: string, dto: ReplaceFieldsDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId)).for("update");
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("published forms cannot be edited");
      }
      await db.delete(formFields).where(eq(formFields.formId, formId));
      const rows = await db
        .insert(formFields)
        .values(
          dto.fields.map((f, position) => ({
            formId,
            tenantId,
            type: f.type,
            label: f.label,
            options: f.options ?? null,
            required: f.required,
            position,
          })),
        )
        .returning();
      return rows;
    });
  }

  async publish(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const [form] = await db.select().from(forms).where(eq(forms.id, formId)).for("update");
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("form is already published");
      }
      const fields = await db.select().from(formFields).where(eq(formFields.formId, formId));
      if (fields.length === 0) {
        throw new ConflictException("cannot publish a form without fields");
      }
      const [updated] = await db
        .update(forms)
        .set({ status: "published" })
        .where(eq(forms.id, formId))
        .returning();
      return updated;
    });
  }
}
