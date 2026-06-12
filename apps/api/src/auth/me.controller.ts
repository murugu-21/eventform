import { Body, Controller, Get, Put } from "@nestjs/common";
import { ZodValidationPipe } from "../zod.pipe";
import { CurrentTenant } from "./current-tenant.decorator";
import { UpdateMeDto, updateMeSchema } from "./me.schemas";
import { Tenant, TenantsService } from "./tenants.service";

@Controller("protected/v1/me")
export class MeController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  me(@CurrentTenant() tenant: Tenant) {
    return { tenantId: tenant.id, name: tenant.name };
  }

  @Put()
  async update(
    @CurrentTenant() tenant: Tenant,
    @Body(new ZodValidationPipe(updateMeSchema)) dto: UpdateMeDto,
  ) {
    const updated = await this.tenants.updateName(tenant.id, dto.name);
    return { tenantId: updated.id, name: updated.name };
  }
}
