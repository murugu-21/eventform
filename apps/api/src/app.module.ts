import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { DbModule } from "./db/db.module";
import { AuthModule } from "./auth/auth.module";
import { FormsModule } from "./forms/forms.module";
import { EndpointsModule } from "./endpoints/endpoints.module";

@Module({
  imports: [DbModule, AuthModule, FormsModule, EndpointsModule],
  controllers: [HealthController],
})
export class AppModule {}
