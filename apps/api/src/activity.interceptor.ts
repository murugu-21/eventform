import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { ACTIVITY_FILE, stampActivity } from "./activity";

const THROTTLE_MS = 10_000;

/**
 * Records the last *real* request time for scale-to-zero idle detection.
 * Excludes `/health` — the compose healthcheck hits it every 10s, so counting
 * it would keep the box awake forever. Throttled to one write per 10s so a busy
 * box doesn't churn the disk. No-op when ACTIVITY_FILE is unset (dev).
 */
@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  private lastWrite = 0;

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ACTIVITY_FILE) {
      const req = ctx.switchToHttp().getRequest<{ url?: string }>();
      const url = req?.url ?? "";
      if (!url.startsWith("/health")) {
        const now = Date.now();
        if (now - this.lastWrite > THROTTLE_MS) {
          this.lastWrite = now;
          stampActivity(now);
        }
      }
    }
    return next.handle();
  }
}
