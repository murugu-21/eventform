import { Controller, Get, Param } from "@nestjs/common";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenants.service";
import { uuidSchema } from "../forms/forms.schemas";
import { ZodValidationPipe } from "../zod.pipe";
import { SubmissionsService } from "./submissions.service";

const uuidPipe = new ZodValidationPipe(uuidSchema);

@Controller("protected/v1/forms/:id/submissions")
export class SubmissionsController {
  constructor(private readonly service: SubmissionsService) {}

  @Get()
  list(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) formId: string) {
    return this.service.listForForm(tenant.id, formId);
  }
}

@Controller("protected/v1/submissions")
export class AllSubmissionsController {
  constructor(private readonly service: SubmissionsService) {}

  @Get()
  list(@CurrentTenant() tenant: Tenant) {
    return this.service.listAll(tenant.id);
  }
}
