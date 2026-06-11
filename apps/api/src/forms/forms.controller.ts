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
import { ZodValidationPipe } from "../zod.pipe";
import {
  CreateFormDto,
  createFormSchema,
  ReplaceFieldsDto,
  replaceFieldsSchema,
  updateFormSchema,
  uuidSchema,
} from "./forms.schemas";
import { FormsService } from "./forms.service";

const uuidPipe = new ZodValidationPipe(uuidSchema);

@Controller("forms")
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Post()
  create(
    @CurrentTenant() tenant: Tenant,
    @Body(new ZodValidationPipe(createFormSchema)) dto: CreateFormDto,
  ) {
    return this.forms.create(tenant.id, dto);
  }

  @Get()
  list(@CurrentTenant() tenant: Tenant) {
    return this.forms.list(tenant.id);
  }

  @Get(":id")
  get(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.forms.getWithFields(tenant.id, id);
  }

  @Put(":id")
  update(
    @CurrentTenant() tenant: Tenant,
    @Param("id", uuidPipe) id: string,
    @Body(new ZodValidationPipe(updateFormSchema)) dto: CreateFormDto,
  ) {
    return this.forms.updateTitle(tenant.id, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.forms.remove(tenant.id, id);
  }

  @Put(":id/fields")
  @HttpCode(200)
  replaceFields(
    @CurrentTenant() tenant: Tenant,
    @Param("id", uuidPipe) id: string,
    @Body(new ZodValidationPipe(replaceFieldsSchema)) dto: ReplaceFieldsDto,
  ) {
    return this.forms.replaceFields(tenant.id, id, dto);
  }

  @Post(":id/publish")
  publish(@CurrentTenant() tenant: Tenant, @Param("id", uuidPipe) id: string) {
    return this.forms.publish(tenant.id, id);
  }
}
