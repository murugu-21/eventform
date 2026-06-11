import { z } from "zod";

export const submissionReceivedSchema = z.object({
  eventId: z.string().uuid(),
  type: z.literal("submission.received"),
  attempt: z.number().int().min(1),
  tenantId: z.string().uuid(),
  formId: z.string().uuid(),
  formTitle: z.string(),
  submissionId: z.string().uuid(),
  endpointId: z.string().uuid(),
  deliveryId: z.string().uuid(),
  answers: z.record(z.string()),
  submittedAt: z.string().datetime(),
});

export type SubmissionReceivedEvent = z.infer<typeof submissionReceivedSchema>;
