import type { Executor } from "@eventform/db";
import type { SubmissionReceivedEvent } from "@eventform/shared";

export const PUBLIC_REPOSITORY = "PUBLIC_REPOSITORY";

export interface PublicFormRecord {
  id: string;
  tenantId: string;
  title: string;
  slug: string;
  fields: {
    id: string;
    type: "text" | "multiple_choice";
    label: string;
    options: string[] | null;
    required: boolean;
    position: number;
  }[];
}

export interface DeliveryWrite {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  payload: SubmissionReceivedEvent;
}

export interface PublicRepository {
  /**
   * Anonymous read: always runs on the pool (no tenant context) so the RLS
   * public-read policies scope to published forms. Returns null if not found.
   */
  findPublishedFormBySlug(slug: string): Promise<PublicFormRecord | null>;
  /** Active endpoints for the tenant — used to fan out deliveries. */
  listActiveEndpointIds(x: Executor, tenantId: string): Promise<string[]>;
  /** Insert the submission and return its id. */
  insertSubmission(
    x: Executor,
    row: { formId: string; tenantId: string; answers: Record<string, string>; sourceIp: string | undefined; submittedAt: Date },
  ): Promise<string>;
  /** Insert one delivery + its outbox row (called once per active endpoint, same tx). */
  insertDeliveryWithOutbox(x: Executor, tenantId: string, write: DeliveryWrite): Promise<void>;
}
