import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthedRequest } from "./auth.guard";
import type { Tenant } from "./tenants.service";

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Tenant =>
    ctx.switchToHttp().getRequest<AuthedRequest>().tenant,
);
