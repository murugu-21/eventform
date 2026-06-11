import { z } from "zod";

/** Static shape of a public submission body — enforced by the pipe layer. */
export const submitBodySchema = z
  .object({ answers: z.record(z.string()) })
  .strict();

export type SubmitBodyDto = z.infer<typeof submitBodySchema>;
