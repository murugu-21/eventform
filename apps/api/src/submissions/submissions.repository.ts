import type { Executor } from "@eventform/db";
import { submissions } from "@eventform/db";

export const SUBMISSION_REPOSITORY = "SUBMISSION_REPOSITORY";

export type SubmissionRow = typeof submissions.$inferSelect;

export interface SubmissionListItem {
  id: string;
  formId: string;
  formTitle: string;
  answers: SubmissionRow["answers"];
  submittedAt: SubmissionRow["submittedAt"];
  sourceIp: SubmissionRow["sourceIp"];
}

export interface SubmissionRepository {
  /** All responses across the tenant's forms, newest first (latest 200). */
  listAll(x: Executor): Promise<SubmissionListItem[]>;
  /** Returns undefined if the form doesn't exist (under the current tenant/RLS). */
  formExists(x: Executor, formId: string): Promise<boolean>;
  listForForm(x: Executor, formId: string): Promise<SubmissionRow[]>;
}
