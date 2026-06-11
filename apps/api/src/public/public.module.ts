import { Module } from "@nestjs/common";
import { PublicController } from "./public.controller";
import { AnswersValidationInterceptor } from "./answers-validation.interceptor";
import { PublicService } from "./public.service";

@Module({
  controllers: [PublicController],
  providers: [PublicService, AnswersValidationInterceptor],
  exports: [PublicService],
})
export class PublicModule {}
