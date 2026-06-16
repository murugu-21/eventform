import { randomBytes } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { withTenant } from "@eventform/db";
import { API_POOL } from "../db/db.module";
import { CreateFormDto, ReplaceFieldsDto } from "./forms.schemas";
import { FORM_REPOSITORY, FormRepository } from "./forms.repository";

@Injectable()
export class FormsService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(FORM_REPOSITORY) private readonly repo: FormRepository,
  ) {}

  create(tenantId: string, dto: CreateFormDto) {
    return withTenant(this.pool, tenantId, (db) =>
      this.repo.insert(db, {
        tenantId,
        title: dto.title,
        publicSlug: randomBytes(6).toString("base64url"),
      }),
    );
  }

  list(tenantId: string) {
    return withTenant(this.pool, tenantId, (db) => this.repo.listByTenant(db));
  }

  async getWithFields(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.findById(db, formId);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      const fields = await this.repo.listFields(db, formId);
      return { ...form, fields };
    });
  }

  async updateTitle(tenantId: string, formId: string, dto: CreateFormDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.updateTitle(db, formId, dto.title);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      return form;
    });
  }

  async remove(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.findByIdForUpdate(db, formId);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("published forms cannot be deleted");
      }
      await this.repo.remove(db, formId);
    });
  }

  async replaceFields(tenantId: string, formId: string, dto: ReplaceFieldsDto) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.findByIdForUpdate(db, formId);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("published forms cannot be edited");
      }
      await this.repo.deleteFields(db, formId);
      return this.repo.insertFields(
        db,
        dto.fields.map((f, position) => ({
          formId,
          tenantId,
          type: f.type,
          label: f.label,
          options: f.options ?? null,
          required: f.required,
          position,
        })),
      );
    });
  }

  async publish(tenantId: string, formId: string) {
    return withTenant(this.pool, tenantId, async (db) => {
      const form = await this.repo.findByIdForUpdate(db, formId);
      if (!form) {
        throw new NotFoundException("form not found");
      }
      if (form.status !== "draft") {
        throw new ConflictException("form is already published");
      }
      const fields = await this.repo.listFields(db, formId);
      if (fields.length === 0) {
        throw new ConflictException("cannot publish a form without fields");
      }
      const updated = await this.repo.setStatus(db, formId, "published");
      return updated;
    });
  }
}
