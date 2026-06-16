import { describe, expect, it } from "vitest";
import { canRetryDelivery } from "../src/domain/delivery-rules";
import {
  buildSubmissionReceivedEvent,
  rebuildRetryEvent,
} from "../src/domain/submission-event";
import { EndpointSecret } from "../src/domain/endpoint-secret";

// Pure domain logic — no infrastructure, nothing to mock.

describe("canRetryDelivery", () => {
  it("allows retry only for failed deliveries", () => {
    expect(canRetryDelivery("failed")).toBe(true);
    for (const status of ["pending", "retrying", "delivered"]) {
      expect(canRetryDelivery(status)).toBe(false);
    }
  });
});

describe("buildSubmissionReceivedEvent", () => {
  const input = {
    tenantId: "t1",
    formId: "f1",
    formTitle: "Title",
    submissionId: "s1",
    endpointId: "e1",
    answers: { name: "alice" },
    submittedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("builds a submission.received payload with fresh ids and attempt 1", () => {
    const { deliveryId, eventId, payload } = buildSubmissionReceivedEvent(input);
    expect(payload.type).toBe("submission.received");
    expect(payload.attempt).toBe(1);
    expect(payload.eventId).toBe(eventId);
    expect(payload.deliveryId).toBe(deliveryId);
    expect(payload.endpointId).toBe("e1");
    expect(payload.submittedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(payload.answers).toEqual({ name: "alice" });
  });

  it("mints distinct event and delivery ids per call", () => {
    const a = buildSubmissionReceivedEvent(input);
    const b = buildSubmissionReceivedEvent(input);
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.deliveryId).not.toBe(b.deliveryId);
  });
});

describe("rebuildRetryEvent", () => {
  it("keeps the body, swaps the eventId, and resets attempt to 1", () => {
    const original = { eventId: "old", attempt: 3, type: "submission.received", body: "x" };
    const rebuilt = rebuildRetryEvent(original, "new");
    expect(rebuilt.eventId).toBe("new");
    expect(rebuilt.attempt).toBe(1);
    expect(rebuilt.type).toBe("submission.received");
    expect(rebuilt.body).toBe("x");
  });
});

describe("EndpointSecret", () => {
  it("generates a whsec_-prefixed secret and round-trips via value/toString", () => {
    const secret = EndpointSecret.generate();
    expect(secret.value.startsWith(EndpointSecret.PREFIX)).toBe(true);
    expect(secret.toString()).toBe(secret.value);
  });

  it("generates unique values", () => {
    expect(EndpointSecret.generate().value).not.toBe(EndpointSecret.generate().value);
  });
});
