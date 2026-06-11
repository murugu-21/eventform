import { Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenants.service";
import { uuidSchema } from "../forms/forms.schemas";
import { ZodValidationPipe } from "../zod.pipe";
import { ListDeliveriesQuery, listDeliveriesQuerySchema } from "./deliveries.schemas";
import { DeliveriesService } from "./deliveries.service";

const uuidPipe = new ZodValidationPipe(uuidSchema);

@Controller("protected/v1/deliveries")
export class DeliveriesController {
  constructor(private readonly service: DeliveriesService) {}

  @Get()
  list(
    @CurrentTenant() tenant: Tenant,
    @Query(new ZodValidationPipe(listDeliveriesQuerySchema)) query: ListDeliveriesQuery,
  ) {
    return this.service.list(tenant.id, query);
  }

  @Get(":id")
  get(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.service.getWithAttempts(tenant.id, id);
  }

  @Post(":id/retry")
  @HttpCode(201)
  retry(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.service.retry(tenant.id, id);
  }
}
