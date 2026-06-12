import { z } from "zod";

export const updateMeSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export type UpdateMeDto = z.infer<typeof updateMeSchema>;
