import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { Pool } from "pg";
import type { SubmissionReceivedEvent } from "@eventform/shared";
import { WORKER_POOL } from "../db.module";
import { loadConfig } from "../config";

@Injectable()
export class RetryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RetryScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(WORKER_POOL) private readonly pool: Pool,
    @Optional() private readonly pollMs: number = loadConfig().retryPollMs,
    @Optional() private readonly enableTimer: boolean = false,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enableTimer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.logger.error(`tick failed: ${err}`));
    }, this.pollMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * Claim due retries with FOR UPDATE SKIP LOCKED and re-emit each through the
   * outbox (new event id, attempt = attempt_count + 1). Same pipeline as the
   * first attempt and as manual retry: "even retries are events".
   * Returns the number of deliveries re-emitted.
   */
  async tick(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query(
        `SELECT d.*, s.answers, s.submitted_at, f.id AS form_id, f.title AS form_title
         FROM deliveries d
         JOIN submissions s ON s.id = d.submission_id
         JOIN forms f ON f.id = s.form_id
         WHERE d.status = 'retrying' AND d.next_retry_at <= now()
         ORDER BY d.next_retry_at
         FOR UPDATE OF d SKIP LOCKED
         LIMIT 10`,
      );
      for (const row of due.rows) {
        const eventId = randomUUID();
        const payload: SubmissionReceivedEvent = {
          eventId,
          type: "submission.received",
          attempt: row.attempt_count + 1,
          tenantId: row.tenant_id,
          formId: row.form_id,
          formTitle: row.form_title,
          submissionId: row.submission_id,
          endpointId: row.endpoint_id,
          deliveryId: row.id,
          answers: row.answers,
          submittedAt: new Date(row.submitted_at).toISOString(),
        };
        await client.query(
          `INSERT INTO outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1,$2,'delivery',$3,'submission.received',$4)`,
          [eventId, row.tenant_id, row.id, JSON.stringify(payload)],
        );
        await client.query(
          "UPDATE deliveries SET status='pending', event_id=$2, next_retry_at=NULL WHERE id=$1",
          [row.id, eventId],
        );
      }
      await client.query("COMMIT");
      if (due.rowCount! > 0) {
        this.logger.log(`re-emitted ${due.rowCount} due deliveries`);
      }
      client.release();
      return due.rowCount ?? 0;
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
}
