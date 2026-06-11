import { Inject, Injectable } from "@nestjs/common";
import { SecretCipher, signWebhook } from "@eventform/shared";
import { SECRET_CIPHER } from "../db.module";

export interface SendArgs {
  url: string;
  secretCiphertext: string;
  tenantId: string;
  endpointId: string;
  payload: unknown;
}

export interface SendResult {
  ok: boolean;
  responseCode: number | null;
  error: string | null;
  durationMs: number;
}

interface CacheEntry {
  ciphertext: string;
  secret: string;
  expiresAt: number;
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class WebhookSender {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
    private readonly timeoutMs: number = 10_000,
  ) {}

  private async secretFor(args: SendArgs): Promise<string> {
    const entry = this.cache.get(args.endpointId);
    const now = Date.now();
    if (entry && entry.ciphertext === args.secretCiphertext && entry.expiresAt > now) {
      return entry.secret;
    }
    const secret = await this.cipher.decrypt(args.secretCiphertext, args.tenantId);
    this.cache.set(args.endpointId, {
      ciphertext: args.secretCiphertext,
      secret,
      expiresAt: now + SECRET_CACHE_TTL_MS,
    });
    return secret;
  }

  async send(args: SendArgs): Promise<SendResult> {
    const started = Date.now();
    try {
      const secret = await this.secretFor(args);
      const body = JSON.stringify(args.payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const eventId =
        typeof args.payload === "object" && args.payload !== null && "eventId" in args.payload
          ? String((args.payload as { eventId: unknown }).eventId)
          : "";

      const res = await fetch(args.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "eventform-webhook/1.0",
          "x-eventform-event-id": eventId,
          "x-eventform-timestamp": timestamp,
          "x-eventform-signature": signWebhook(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual",
      });
      // drain the body so the socket is released
      await res.arrayBuffer().catch(() => undefined);
      return {
        ok: res.status >= 200 && res.status < 300,
        responseCode: res.status,
        error: res.status >= 200 && res.status < 300 ? null : `http ${res.status}`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        responseCode: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        durationMs: Date.now() - started,
      };
    }
  }
}
