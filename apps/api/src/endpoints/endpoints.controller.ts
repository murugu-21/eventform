import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { Tenant } from "../auth/tenants.service";
import { uuidSchema } from "../forms/forms.schemas";
import { ZodValidationPipe } from "../zod.pipe";
import {
  CreateEndpointDto,
  createEndpointSchema,
  UpdateEndpointDto,
  updateEndpointSchema,
} from "./endpoints.schemas";
import { EndpointsService } from "./endpoints.service";

const uuidPipe = new ZodValidationPipe(uuidSchema);

@Controller("endpoints")
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Post()
  create(
    @CurrentTenant() tenant: Tenant,
    @Body(new ZodValidationPipe(createEndpointSchema)) dto: CreateEndpointDto,
  ) {
    return this.endpoints.create(tenant.id, dto);
  }

  @Get()
  list(@CurrentTenant() tenant: Tenant) {
    return this.endpoints.list(tenant.id);
  }

  @Put(":id")
  update(
    @CurrentTenant() tenant: Tenant,
    @Param("id", uuidPipe) id: string,
    @Body(new ZodValidationPipe(updateEndpointSchema)) dto: UpdateEndpointDto,
  ) {
    return this.endpoints.update(tenant.id, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.endpoints.remove(tenant.id, id);
  }

  @Get(":id/secret")
  reveal(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.endpoints.revealSecret(tenant.id, id);
  }

  @Post(":id/rotate")
  rotate(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.endpoints.rotateSecret(tenant.id, id);
  }
}
