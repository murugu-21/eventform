import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "../src/hmac";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ hello: "world" });
const TS = "1760000000";

describe("signWebhook", () => {
  it("produces a sha256= prefixed hex signature", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    expect(signWebhook(SECRET, TS, BODY)).toBe(signWebhook(SECRET, TS, BODY));
  });

  it("changes when the body changes", () => {
    expect(signWebhook(SECRET, TS, BODY)).not.toBe(signWebhook(SECRET, TS, BODY + "x"));
  });
});

describe("verifyWebhook", () => {
  it("accepts a valid signature within tolerance", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: sig,
        nowEpochSeconds: Number(TS) + 60,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY + "tampered",
        signature: sig,
        nowEpochSeconds: Number(TS) + 60,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp outside tolerance", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: sig,
        toleranceSeconds: 300,
        nowEpochSeconds: Number(TS) + 301,
      }),
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = signWebhook("other_secret", TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: sig,
        nowEpochSeconds: Number(TS) + 60,
      }),
    ).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: "not-a-number",
        body: BODY,
        signature: sig,
        nowEpochSeconds: Number(TS),
      }),
    ).toBe(false);
  });
});
