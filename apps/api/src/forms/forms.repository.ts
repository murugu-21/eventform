import type { Executor } from "@eventform/db";
import { formFields, forms } from "@eventform/db";

export const FORM_REPOSITORY = "FORM_REPOSITORY";

export type FormRow = typeof forms.$inferSelect;
export type FormFieldRow = typeof formFields.$inferSelect;

export interface NewFormField {
  formId: string;
  tenantId: string;
  type: FormFieldRow["type"];
  label: string;
  options: string[] | null;
  required: boolean;
  position: number;
}

export interface FormRepository {
  insert(x: Executor, values: { tenantId: string; title: string; publicSlug: string }): Promise<FormRow>;
  listByTenant(x: Executor): Promise<FormRow[]>;
  findById(x: Executor, formId: string): Promise<FormRow | undefined>;
  findByIdForUpdate(x: Executor, formId: string): Promise<FormRow | undefined>;
  updateTitle(x: Executor, formId: string, title: string): Promise<FormRow | undefined>;
  setStatus(x: Executor, formId: string, status: FormRow["status"]): Promise<FormRow | undefined>;
  remove(x: Executor, formId: string): Promise<void>;
  listFields(x: Executor, formId: string): Promise<FormFieldRow[]>;
  deleteFields(x: Executor, formId: string): Promise<void>;
  insertFields(x: Executor, rows: NewFormField[]): Promise<FormFieldRow[]>;
}
