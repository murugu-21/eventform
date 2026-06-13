import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";
import { clientIp } from "./client-ip";

/**
 * Rate-limits by the true client IP from `CF-Connecting-IP` (set by Cloudflare,
 * which is the only ingress) instead of the default `req.ip`. This removes the
 * fragile `X-Forwarded-For` hop counting / `trust proxy` tuning — the limiter
 * keys off the real client regardless of how many proxies sit in front.
 */
@Injectable()
export class CfThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(clientIp(req as unknown as Request));
  }
}
