import { Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { formFields, forms, type Executor } from "@eventform/db";
import { FormFieldRow, FormRepository, FormRow, NewFormField } from "./forms.repository";

@Injectable()
export class DrizzleFormRepository implements FormRepository {
  async insert(
    x: Executor,
    values: { tenantId: string; title: string; publicSlug: string },
  ): Promise<FormRow> {
    const [form] = await x.insert(forms).values(values).returning();
    return form;
  }

  listByTenant(x: Executor): Promise<FormRow[]> {
    return x.select().from(forms).orderBy(asc(forms.createdAt));
  }

  async findById(x: Executor, formId: string): Promise<FormRow | undefined> {
    const [form] = await x.select().from(forms).where(eq(forms.id, formId));
    return form;
  }

  async findByIdForUpdate(x: Executor, formId: string): Promise<FormRow | undefined> {
    const [form] = await x.select().from(forms).where(eq(forms.id, formId)).for("update");
    return form;
  }

  async updateTitle(x: Executor, formId: string, title: string): Promise<FormRow | undefined> {
    const [form] = await x.update(forms).set({ title }).where(eq(forms.id, formId)).returning();
    return form;
  }

  async setStatus(
    x: Executor,
    formId: string,
    status: FormRow["status"],
  ): Promise<FormRow | undefined> {
    const [form] = await x.update(forms).set({ status }).where(eq(forms.id, formId)).returning();
    return form;
  }

  async remove(x: Executor, formId: string): Promise<void> {
    await x.delete(forms).where(eq(forms.id, formId)); // fields cascade
  }

  listFields(x: Executor, formId: string): Promise<FormFieldRow[]> {
    return x
      .select()
      .from(formFields)
      .where(eq(formFields.formId, formId))
      .orderBy(asc(formFields.position));
  }

  async deleteFields(x: Executor, formId: string): Promise<void> {
    await x.delete(formFields).where(eq(formFields.formId, formId));
  }

  insertFields(x: Executor, rows: NewFormField[]): Promise<FormFieldRow[]> {
    return x.insert(formFields).values(rows).returning();
  }
}
