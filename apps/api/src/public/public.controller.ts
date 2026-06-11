import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { Throttle, seconds } from "@nestjs/throttler";
import { Public } from "../auth/auth.guard";
import { loadConfig } from "../config";
import { ZodValidationPipe } from "../zod.pipe";
import {
  AnswersValidationInterceptor,
  ValidatedForm,
} from "./answers-validation.interceptor";
import { SubmitBodyDto, submitBodySchema } from "./public.schemas";
import { PublicService, ResolvedForm } from "./public.service";

@Public()
@Controller("v1/forms")
export class PublicController {
  constructor(private readonly service: PublicService) {}

  @Get(":slug")
  async getForm(@Param("slug") slug: string) {
    return this.service.toPublicForm(await this.service.resolvePublishedForm(slug));
  }

  @Post(":slug")
  @HttpCode(201)
  @Throttle({
    default: {
      ttl: seconds(loadConfig().throttleTtlSeconds),
      limit: loadConfig().publicSubmitLimit,
    },
  })
  @UseInterceptors(AnswersValidationInterceptor)
  submit(
    @ValidatedForm() form: ResolvedForm,
    @Body(new ZodValidationPipe(submitBodySchema)) body: SubmitBodyDto,
    @Ip() ip: string,
  ) {
    return this.service.submit(form, body.answers, ip);
  }
}
