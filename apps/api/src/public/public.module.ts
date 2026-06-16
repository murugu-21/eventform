import { Module } from "@nestjs/common";
import { PublicController } from "./public.controller";
import { AnswersValidationInterceptor } from "./answers-validation.interceptor";
import { PublicService } from "./public.service";
import { PUBLIC_REPOSITORY } from "./public.repository";
import { DrizzlePublicRepository } from "./public.repository.drizzle";

@Module({
  controllers: [PublicController],
  providers: [
    PublicService,
    AnswersValidationInterceptor,
    { provide: PUBLIC_REPOSITORY, useClass: DrizzlePublicRepository },
  ],
  exports: [PublicService],
})
export class PublicModule {}
