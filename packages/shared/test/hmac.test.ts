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

  // --- new edge tests ---

  it("rejects a future timestamp outside tolerance", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: sig,
        toleranceSeconds: 300,
        nowEpochSeconds: Number(TS) - 301,
      }),
    ).toBe(false);
  });

  it("accepts skew exactly at the tolerance boundary (inclusive)", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: sig,
        toleranceSeconds: 300,
        nowEpochSeconds: Number(TS) + 300,
      }),
    ).toBe(true);
  });

  it("rejects a decimal timestamp (boundary-shift regression)", () => {
    // Signature minted over ts="1760000000" and body="123.xyz"
    const decimalBody = "123.xyz";
    const sigOverDecimalBody = signWebhook(SECRET, TS, decimalBody);
    // Attacker tries to verify with ts="1760000000.123" and body="xyz"
    // because HMAC input "1760000000.123.xyz" === "1760000000" + "." + "123.xyz"
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: "1760000000.123",
        body: "xyz",
        signature: sigOverDecimalBody,
        nowEpochSeconds: Number(TS),
      }),
    ).toBe(false);
  });

  it("rejects a whitespace-padded timestamp", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: " 1760000000 ",
        body: BODY,
        signature: sig,
        nowEpochSeconds: Number(TS),
      }),
    ).toBe(false);
  });

  it("rejects a signature without the sha256= prefix", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    const noPrefix = sig.replace("sha256=", "");
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: noPrefix,
        nowEpochSeconds: Number(TS),
      }),
    ).toBe(false);
  });

  it("rejects an empty signature string", () => {
    expect(
      verifyWebhook({
        secret: SECRET,
        timestamp: TS,
        body: BODY,
        signature: "",
        nowEpochSeconds: Number(TS),
      }),
    ).toBe(false);
  });

  it("signWebhook throws on empty secret", () => {
    expect(() => signWebhook("", TS, BODY)).toThrow("webhook secret must not be empty");
  });

  it("verifyWebhook throws on empty secret", () => {
    const sig = signWebhook(SECRET, TS, BODY);
    expect(() =>
      verifyWebhook({
        secret: "",
        timestamp: TS,
        body: BODY,
        signature: sig,
        nowEpochSeconds: Number(TS),
      }),
    ).toThrow("webhook secret must not be empty");
  });
});
