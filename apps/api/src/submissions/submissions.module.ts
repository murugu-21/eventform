import { Module } from "@nestjs/common";
import { AllSubmissionsController, SubmissionsController } from "./submissions.controller";
import { SubmissionsService } from "./submissions.service";

@Module({
  controllers: [SubmissionsController, AllSubmissionsController],
  providers: [SubmissionsService],
})
export class SubmissionsModule {}
