import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(secret: string, timestamp: string, body: string): string {
  if (secret === "") {
    throw new Error("webhook secret must not be empty");
  }
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${mac}`;
}

export interface VerifyWebhookParams {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  /** Maximum allowed clock skew in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Injectable clock for tests. Defaults to Date.now(). */
  nowEpochSeconds?: number;
}

export function verifyWebhook(params: VerifyWebhookParams): boolean {
  const { secret, timestamp, body, signature, toleranceSeconds = 300 } = params;
  if (secret === "") {
    throw new Error("webhook secret must not be empty");
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    return false;
  }
  const ts = Number(timestamp);
  const now = params.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return false;
  }
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
