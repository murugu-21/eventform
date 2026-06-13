import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/**
 * The real client IP. Behind the Cloudflare tunnel — the only ingress (the box
 * publishes no inbound ports) — Cloudflare sets `CF-Connecting-IP` to the true
 * client and clients cannot override it, so there's no need to count
 * `X-Forwarded-For` hops or configure Express `trust proxy`. Falls back to the
 * socket IP in local dev, where there is no Cloudflare in front.
 */
export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  return req.ip ?? "unknown";
}

/** Param decorator form of {@link clientIp}, replacing Nest's `@Ip()`. */
export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext): string =>
  clientIp(ctx.switchToHttp().getRequest<Request>()),
);
