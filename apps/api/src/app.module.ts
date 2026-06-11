import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { DbModule } from "./db/db.module";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [DbModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
