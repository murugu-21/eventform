import { Module } from "@nestjs/common";
import { FormsController } from "./forms.controller";
import { FormsService } from "./forms.service";
import { FORM_REPOSITORY } from "./forms.repository";
import { DrizzleFormRepository } from "./forms.repository.drizzle";

@Module({
  controllers: [FormsController],
  providers: [
    FormsService,
    { provide: FORM_REPOSITORY, useClass: DrizzleFormRepository },
  ],
})
export class FormsModule {}
