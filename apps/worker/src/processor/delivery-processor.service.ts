import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Pool, PoolClient } from "pg";
import type { SubmissionReceivedEvent } from "@eventform/shared";
import { WORKER_POOL } from "../db.module";
import { MAX_ATTEMPTS, nextRetryDelayMs } from "./backoff";
import { WebhookSender } from "../webhook/webhook-sender.service";

export type ProcessOutcome =
  | "delivered"
  | "retry_scheduled"
  | "failed"
  | "duplicate"
  | "stale"
  | "orphan";

export interface ProcessorHooks {
  /** Test seam: runs after the HTTP send, before commit. */
  afterSendHook?: () => void;
}

@Injectable()
export class DeliveryProcessor {
  private readonly logger = new Logger(DeliveryProcessor.name);

  constructor(
    @Inject(WORKER_POOL) private readonly pool: Pool,
    private readonly sender: WebhookSender,
    @Optional() private readonly hooks: ProcessorHooks = {},
  ) {}

  /**
   * One transaction per event:
   *   claim processed_events (idempotency) → lock delivery FOR UPDATE →
   *   HTTP send → record attempt → advance status machine → COMMIT.
   * A crash after the send rolls everything back, so redelivery re-sends:
   * that is the documented at-least-once contract (receivers dedupe on
   * X-Eventform-Event-Id).
   */
  async process(event: SubmissionReceivedEvent): Promise<ProcessOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.run(client, event);
      await client.query("COMMIT");
      client.release();
      return outcome;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
        client.release();
      } catch {
        client.release(err as Error);
      }
      throw err;
    }
  }

  private async run(client: PoolClient, event: SubmissionReceivedEvent): Promise<ProcessOutcome> {
    const claim = await client.query(
      "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.eventId],
    );
    if (claim.rowCount === 0) {
      return "duplicate";
    }

    const found = await client.query("SELECT * FROM deliveries WHERE id = $1 FOR UPDATE", [
      event.deliveryId,
    ]);
    if (found.rowCount === 0) {
      this.logger.warn(`orphan event ${event.eventId}: delivery ${event.deliveryId} missing`);
      return "orphan";
    }
    const delivery = found.rows[0];
    if (delivery.status === "delivered" || delivery.status === "failed") {
      return "stale";
    }

    const endpointRes = await client.query(
      "SELECT url, secret_ciphertext FROM endpoints WHERE id = $1",
      [delivery.endpoint_id],
    );
    if (endpointRes.rowCount === 0) {
      this.logger.warn(`delivery ${delivery.id}: endpoint ${delivery.endpoint_id} missing`);
      return "orphan";
    }
    const endpoint = endpointRes.rows[0];

    const attemptNo = delivery.attempt_count + 1;
    const result = await this.sender.send({
      url: endpoint.url,
      secretCiphertext: endpoint.secret_ciphertext,
      tenantId: delivery.tenant_id,
      endpointId: delivery.endpoint_id,
      payload: { ...event, attempt: attemptNo },
    });
    this.hooks.afterSendHook?.();

    await client.query(
      `INSERT INTO delivery_attempts (delivery_id, tenant_id, attempt_no, response_code, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [delivery.id, delivery.tenant_id, attemptNo, result.responseCode, result.error, result.durationMs],
    );

    if (result.ok) {
      await client.query(
        `UPDATE deliveries SET status='delivered', attempt_count=$2, response_code=$3,
         last_error=NULL, next_retry_at=NULL, delivered_at=now() WHERE id=$1`,
        [delivery.id, attemptNo, result.responseCode],
      );
      return "delivered";
    }

    const delayMs = nextRetryDelayMs(attemptNo);
    if (delayMs === null) {
      await client.query(
        `UPDATE deliveries SET status='failed', attempt_count=$2, response_code=$3,
         last_error=$4, next_retry_at=NULL WHERE id=$1`,
        [delivery.id, attemptNo, result.responseCode, result.error],
      );
      this.logger.warn(`delivery ${delivery.id} failed after ${MAX_ATTEMPTS} attempts`);
      return "failed";
    }

    await client.query(
      `UPDATE deliveries SET status='retrying', attempt_count=$2, response_code=$3,
       last_error=$4, next_retry_at=now() + ($5 || ' milliseconds')::interval WHERE id=$1`,
      [delivery.id, attemptNo, result.responseCode, result.error, String(delayMs)],
    );
    return "retry_scheduled";
  }
}
