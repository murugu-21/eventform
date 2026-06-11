import { Body, Controller, Get, HttpCode, Ip, Param, Post } from "@nestjs/common";
import { Throttle, seconds } from "@nestjs/throttler";
import { Public } from "../auth/auth.guard";
import { loadConfig } from "../config";
import { PublicService } from "./public.service";

@Public()
@Controller("f")
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
  submit(
    @Param("slug") slug: string,
    @Body() body: { answers?: Record<string, unknown> },
    @Ip() ip: string,
  ) {
    return this.service.submit(slug, body, ip);
  }
}
