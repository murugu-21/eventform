import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule, seconds } from "@nestjs/throttler";
import { HealthController } from "./health.controller";
import { DbModule } from "./db/db.module";
import { AuthModule } from "./auth/auth.module";
import { FormsModule } from "./forms/forms.module";
import { EndpointsModule } from "./endpoints/endpoints.module";
import { PublicModule } from "./public/public.module";
import { SubmissionsModule } from "./submissions/submissions.module";
import { DrizzleExceptionFilter } from "./drizzle-exception.filter";
import { loadConfig } from "./config";

@Module({
  imports: [
    DbModule,
    AuthModule,
    FormsModule,
    EndpointsModule,
    PublicModule,
    SubmissionsModule,
    ThrottlerModule.forRoot({
      throttlers: [
        { ttl: seconds(loadConfig().throttleTtlSeconds), limit: loadConfig().throttleLimit },
      ],
    }),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: DrizzleExceptionFilter },
  ],
})
export class AppModule {}
