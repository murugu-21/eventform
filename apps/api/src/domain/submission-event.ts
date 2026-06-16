import { randomUUID } from "node:crypto";
import type { SubmissionReceivedEvent } from "@eventform/shared";

/**
 * Domain layer (framework-free): the rules that define EventForm's events and
 * delivery behaviour, expressed as pure functions over plain values. No NestJS,
 * no Drizzle — services call these and keep owning transactions + HTTP errors.
 */

export interface SubmissionEventInput {
  tenantId: string;
  formId: string;
  formTitle: string;
  submissionId: string;
  endpointId: string;
  answers: Record<string, string>;
  submittedAt: Date;
}

/**
 * Construct a fresh `submission.received` event for one (submission, endpoint)
 * pair. Mints the event id and delivery id (so a submission fanning out to N
 * endpoints yields N distinct events), and stamps attempt = 1.
 */
export function buildSubmissionReceivedEvent(input: SubmissionEventInput): {
  deliveryId: string;
  eventId: string;
  payload: SubmissionReceivedEvent;
} {
  const deliveryId = randomUUID();
  const eventId = randomUUID();
  const payload: SubmissionReceivedEvent = {
    eventId,
    type: "submission.received",
    attempt: 1,
    tenantId: input.tenantId,
    formId: input.formId,
    formTitle: input.formTitle,
    submissionId: input.submissionId,
    endpointId: input.endpointId,
    deliveryId,
    answers: input.answers,
    submittedAt: input.submittedAt.toISOString(),
  };
  return { deliveryId, eventId, payload };
}

/**
 * Manual-retry envelope: re-emit the same stored body with a fresh event id and
 * attempt reset to 1. The machinery only rewrites the two envelope fields it
 * owns (`eventId`, `attempt`); the producer-supplied body is preserved.
 */
export function rebuildRetryEvent<T>(
  payload: T,
  eventId: string,
): T & { eventId: string; attempt: number } {
  return { ...payload, eventId, attempt: 1 };
}
