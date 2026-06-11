import { z } from "zod";

const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "url must be http(s)",
  });

export const createEndpointSchema = z
  .object({ name: z.string().min(1).max(100), url: httpUrl })
  .strict();

export const updateEndpointSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: httpUrl.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: "empty update" });

export type CreateEndpointDto = z.infer<typeof createEndpointSchema>;
export type UpdateEndpointDto = z.infer<typeof updateEndpointSchema>;
