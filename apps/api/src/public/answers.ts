import type { PublicField } from "./public.service";

const MAX_TEXT_LENGTH = 5000;

/** Returns human-readable validation errors; empty array = valid. */
export function validateAnswers(
  fields: PublicField[],
  answers: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const byLabel = new Map(fields.map((f) => [f.label, f]));

  for (const key of Object.keys(answers)) {
    if (!byLabel.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  for (const field of fields) {
    const value = Object.hasOwn(answers, field.label) ? answers[field.label] : undefined;
    if (value === undefined || value === "") {
      if (field.required) {
        errors.push(`missing required field: ${field.label}`);
      }
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`field must be a string: ${field.label}`);
      continue;
    }
    if (field.type === "multiple_choice" && !(field.options ?? []).includes(value)) {
      errors.push(`invalid option for field: ${field.label}`);
    }
    if (field.type === "text" && value.length > MAX_TEXT_LENGTH) {
      errors.push(`answer too long for field: ${field.label}`);
    }
  }
  return errors;
}
