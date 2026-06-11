import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { Pool } from "pg";
import { WORKER_POOL } from "../db.module";
import { loadConfig } from "../config";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

@Injectable()
export class OutboxCleanup implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxCleanup.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(WORKER_POOL) private readonly pool: Pool,
    @Optional() private readonly retentionHours: number = loadConfig().outboxRetentionHours,
    @Optional() private readonly enableTimer: boolean = false,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enableTimer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.logger.error(`cleanup failed: ${err}`));
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Debezium reads the WAL, so deleting captured rows is safe. */
  async tick(): Promise<number> {
    const res = await this.pool.query(
      "DELETE FROM outbox WHERE created_at < now() - ($1 || ' hours')::interval",
      [String(this.retentionHours)],
    );
    if (res.rowCount! > 0) {
      this.logger.log(`pruned ${res.rowCount} captured outbox rows`);
    }
    return res.rowCount ?? 0;
  }
}
