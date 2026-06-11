import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, nextRetryDelayMs } from "../src/processor/backoff";

describe("backoff", () => {
  it("is 5s after the first failed attempt", () => {
    expect(nextRetryDelayMs(1)).toBe(5_000);
  });
  it("is 30s after the second failed attempt", () => {
    expect(nextRetryDelayMs(2)).toBe(30_000);
  });
  it("is null at the attempt cap (terminal)", () => {
    expect(nextRetryDelayMs(3)).toBeNull();
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
