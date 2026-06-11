import { Controller, Get, Param } from "@nestjs/common";
import { Public } from "../auth/auth.guard";
import { PublicService } from "./public.service";

@Public()
@Controller("f")
export class PublicController {
  constructor(private readonly service: PublicService) {}

  @Get(":slug")
  async getForm(@Param("slug") slug: string) {
    return this.service.toPublicForm(await this.service.resolvePublishedForm(slug));
  }
}
