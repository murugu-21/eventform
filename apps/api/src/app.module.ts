import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { HealthController } from "./health.controller";
import { DbModule } from "./db/db.module";
import { AuthModule } from "./auth/auth.module";
import { FormsModule } from "./forms/forms.module";
import { EndpointsModule } from "./endpoints/endpoints.module";
import { PublicModule } from "./public/public.module";
import { DrizzleExceptionFilter } from "./drizzle-exception.filter";

@Module({
  imports: [DbModule, AuthModule, FormsModule, EndpointsModule, PublicModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: DrizzleExceptionFilter }],
})
export class AppModule {}
