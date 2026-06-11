import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretCipher, verifyWebhook } from "@eventform/shared";
import { WebhookSender } from "../src/webhook/webhook-sender.service";
import { startTestServer, TestServer } from "./test-server";

const cipher = new SecretCipher({
  keyId: "alias/eventform-endpoint-secrets",
  endpoint: "http://localhost:4566",
  region: "us-east-1",
});

describe("WebhookSender", () => {
  let server: TestServer;
  const tenantId = randomUUID();
  const secret = "whsec_" + "ab".repeat(24);
  let ciphertext: string;

  beforeAll(async () => {
    server = await startTestServer();
    ciphertext = await cipher.encrypt(secret, tenantId);
  });

  afterAll(async () => {
    await server.close();
  });

  function sender(timeoutMs = 2000) {
    return new WebhookSender(cipher, timeoutMs);
  }

  it("POSTs a payload with verifiable HMAC headers", async () => {
    const body = { eventId: randomUUID(), hello: "world" };
    const result = await sender().send({
      url: server.url,
      secretCiphertext: ciphertext,
      tenantId,
      endpointId: randomUUID(),
      payload: body,
    });
    expect(result.ok).toBe(true);
    expect(result.responseCode).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const hit = server.received.at(-1)!;
    expect(hit.headers["x-eventform-event-id"]).toBe(body.eventId);
    const ok = verifyWebhook({
      secret,
      timestamp: hit.headers["x-eventform-timestamp"] as string,
      body: hit.body,
      signature: hit.headers["x-eventform-signature"] as string,
    });
    expect(ok).toBe(true);
    expect(JSON.parse(hit.body)).toEqual(body);
  });

  it("reports non-2xx as failure with the status code", async () => {
    server.setStatus(500);
    const result = await sender().send({
      url: server.url,
      secretCiphertext: ciphertext,
      tenantId,
      endpointId: randomUUID(),
      payload: { x: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.responseCode).toBe(500);
    server.setStatus(200);
  });

  it("times out and reports an error without a response code", async () => {
    server.setDelayMs(1500);
    const result = await sender(300).send({
      url: server.url,
      secretCiphertext: ciphertext,
      tenantId,
      endpointId: randomUUID(),
      payload: { x: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.responseCode).toBeNull();
    expect(result.error).toMatch(/abort|timeout/i);
    server.setDelayMs(0);
  });

  it("reports connection refusal as failure", async () => {
    const result = await sender().send({
      url: "http://127.0.0.1:1/hook",
      secretCiphertext: ciphertext,
      tenantId,
      endpointId: randomUUID(),
      payload: { x: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.responseCode).toBeNull();
  });

  it("caches decrypted secrets per endpoint+ciphertext", async () => {
    const endpointId = randomUUID();
    const spy = { count: 0 };
    const countingCipher = {
      decrypt: async (ct: string, t: string) => {
        spy.count += 1;
        return cipher.decrypt(ct, t);
      },
    } as unknown as SecretCipher;
    const s = new WebhookSender(countingCipher, 2000);
    const args = { url: server.url, secretCiphertext: ciphertext, tenantId, endpointId, payload: { a: 1 } };
    await s.send(args);
    await s.send(args);
    expect(spy.count).toBe(1);
    // rotation: a different ciphertext busts the cache entry
    const rotated = await cipher.encrypt("whsec_" + "cd".repeat(24), tenantId);
    await s.send({ ...args, secretCiphertext: rotated });
    expect(spy.count).toBe(2);
  });
});
