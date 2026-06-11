import { z } from "zod";

// .strict(): producer (api) and consumer (worker) deploy together from this
// repo, so unknown keys indicate a contract bug — fail loudly, don't strip.
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
}).strict();

export type SubmissionReceivedEvent = z.infer<typeof submissionReceivedSchema>;
