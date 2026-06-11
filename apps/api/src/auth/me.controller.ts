import { Controller, Get } from "@nestjs/common";
import { CurrentTenant } from "./current-tenant.decorator";
import { Tenant } from "./tenants.service";

@Controller("protected/v1/me")
export class MeController {
  @Get()
  me(@CurrentTenant() tenant: Tenant) {
    return { tenantId: tenant.id, name: tenant.name };
  }
}
