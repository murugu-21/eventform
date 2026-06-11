import { Module } from "@nestjs/common";
import { DbModule } from "./db.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [DbModule],
  controllers: [HealthController],
})
export class AppModule {}
