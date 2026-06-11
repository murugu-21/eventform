export type FormStatus = "draft" | "published";
export type FieldType = "text" | "multiple_choice";
export type DeliveryStatus = "pending" | "delivered" | "retrying" | "failed";

export interface Form {
  id: string;
  title: string;
  status: FormStatus;
  publicSlug: string;
  createdAt: string;
}

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  options: string[] | null;
  required: boolean;
  position: number;
}

export interface FormWithFields extends Form {
  fields: FormField[];
}

export interface PublicForm {
  id: string;
  title: string;
  slug: string;
  fields: FormField[];
}

export interface Endpoint {
  id: string;
  name: string;
  url: string;
  active: boolean;
  createdAt: string;
}

export interface EndpointWithSecret extends Endpoint {
  secret: string; // present ONLY on create/rotate responses
}

export interface Submission {
  id: string;
  formId: string;
  answers: Record<string, string>;
  submittedAt: string;
  sourceIp: string | null;
}

export interface Delivery {
  id: string;
  endpointId: string;
  endpointName: string;
  submissionId: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  responseCode: number | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface DeliveryAttempt {
  id: string;
  attemptNo: number;
  requestedAt: string;
  responseCode: number | null;
  error: string | null;
  durationMs: number | null;
}

export interface DeliveryDetail extends Delivery {
  attempts: DeliveryAttempt[];
}
