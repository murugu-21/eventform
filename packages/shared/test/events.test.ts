import { describe, expect, it } from "vitest";
import { z } from "zod";
import { submissionReceivedSchema } from "../src/events";

const VALID = {
  eventId: "0d4f9d40-0000-4000-8000-000000000001",
  type: "submission.received",
  attempt: 1,
  tenantId: "0d4f9d40-0000-4000-8000-000000000002",
  formId: "0d4f9d40-0000-4000-8000-000000000003",
  formTitle: "Customer feedback",
  submissionId: "0d4f9d40-0000-4000-8000-000000000004",
  endpointId: "0d4f9d40-0000-4000-8000-000000000005",
  deliveryId: "0d4f9d40-0000-4000-8000-000000000006",
  answers: { "What is your name?": "Ada", "Rating?": "Good" },
  submittedAt: "2026-06-11T10:00:00.000Z",
};

describe("submissionReceivedSchema", () => {
  it("parses a valid event", () => {
    const event = submissionReceivedSchema.parse(VALID);
    expect(event.type).toBe("submission.received");
    expect(event.answers["What is your name?"]).toBe("Ada");
  });

  it("rejects a wrong type literal", () => {
    expect(() =>
      submissionReceivedSchema.parse({ ...VALID, type: "submission.deleted" }),
    ).toThrow(z.ZodError);
  });

  it("rejects attempt 0", () => {
    expect(() => submissionReceivedSchema.parse({ ...VALID, attempt: 0 })).toThrow(z.ZodError);
  });

  it("rejects a non-uuid eventId", () => {
    expect(() => submissionReceivedSchema.parse({ ...VALID, eventId: "nope" })).toThrow(z.ZodError);
  });

  it("rejects non-string answer values", () => {
    expect(() =>
      submissionReceivedSchema.parse({ ...VALID, answers: { q: 42 } }),
    ).toThrow(z.ZodError);
  });

  it("rejects unknown extra keys (strict contract)", () => {
    expect(() =>
      submissionReceivedSchema.parse({ ...VALID, extra: "nope" }),
    ).toThrow(z.ZodError);
  });

  it("rejects non-UTC submittedAt offsets", () => {
    expect(() =>
      submissionReceivedSchema.parse({ ...VALID, submittedAt: "2026-06-11T10:00:00+05:30" }),
    ).toThrow(z.ZodError);
  });
});
