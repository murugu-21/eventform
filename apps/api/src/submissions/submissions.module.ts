import { Module } from "@nestjs/common";
import { AllSubmissionsController, SubmissionsController } from "./submissions.controller";
import { SubmissionsService } from "./submissions.service";
import { SUBMISSION_REPOSITORY } from "./submissions.repository";
import { DrizzleSubmissionRepository } from "./submissions.repository.drizzle";

@Module({
  controllers: [SubmissionsController, AllSubmissionsController],
  providers: [
    SubmissionsService,
    { provide: SUBMISSION_REPOSITORY, useClass: DrizzleSubmissionRepository },
  ],
})
export class SubmissionsModule {}
