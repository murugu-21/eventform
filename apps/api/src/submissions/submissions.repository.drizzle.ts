import { Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { forms, submissions, type Executor } from "@eventform/db";
import {
  SubmissionListItem,
  SubmissionRepository,
  SubmissionRow,
} from "./submissions.repository";

@Injectable()
export class DrizzleSubmissionRepository implements SubmissionRepository {
  listAll(x: Executor): Promise<SubmissionListItem[]> {
    return x
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
      .limit(200);
  }

  async formExists(x: Executor, formId: string): Promise<boolean> {
    const [form] = await x.select({ id: forms.id }).from(forms).where(eq(forms.id, formId));
    return Boolean(form);
  }

  listForForm(x: Executor, formId: string): Promise<SubmissionRow[]> {
    return x
      .select()
      .from(submissions)
      .where(eq(submissions.formId, formId))
      .orderBy(desc(submissions.submittedAt));
  }
}
