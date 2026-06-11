import { z } from "zod";

export const createFormSchema = z.object({ title: z.string().min(1).max(200) }).strict();
export const updateFormSchema = createFormSchema;

const fieldSchema = z
  .object({
    type: z.enum(["text", "multiple_choice"]),
    label: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(200)).min(2).max(20).optional(),
    required: z.boolean().default(false),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === "multiple_choice" && !field.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "multiple_choice requires options" });
    }
    if (field.type === "text" && field.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "text fields cannot have options" });
    }
  });

export const replaceFieldsSchema = z
  .object({ fields: z.array(fieldSchema).min(1).max(50) })
  .strict();

export type CreateFormDto = z.infer<typeof createFormSchema>;
export type ReplaceFieldsDto = z.infer<typeof replaceFieldsSchema>;

export const uuidSchema = z.string().uuid();
