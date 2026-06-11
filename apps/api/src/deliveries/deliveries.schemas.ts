import { z } from "zod";

export const listDeliveriesQuerySchema = z
  .object({
    status: z.enum(["pending", "delivered", "retrying", "failed"]).optional(),
    endpointId: z.string().uuid().optional(),
  })
  .strict();

export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;
