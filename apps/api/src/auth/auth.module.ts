import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { loadConfig } from "../config";
import { AuthGuard } from "./auth.guard";
import { DevTokenVerifier } from "./dev-token-verifier";
import { MeController } from "./me.controller";
import { TenantsService } from "./tenants.service";
import { TOKEN_VERIFIER } from "./token-verifier";

@Module({
  controllers: [MeController],
  providers: [
    TenantsService,
    {
      provide: TOKEN_VERIFIER,
      useFactory: () => {
        if (loadConfig().authMode !== "dev") {
          throw new Error("AUTH_MODE=cognito requires the Phase 5 Cognito verifier");
        }
        return new DevTokenVerifier();
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TenantsService],
})
export class AuthModule {}
