import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { loadConfig } from "../config";
import { AuthGuard } from "./auth.guard";
import { CognitoTokenVerifier } from "./cognito-token-verifier";
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
        const cfg = loadConfig();
        if (cfg.authMode === "cognito") {
          if (!cfg.cognitoIssuer || !cfg.cognitoClientId) {
            throw new Error(
              "AUTH_MODE=cognito requires both COGNITO_ISSUER and COGNITO_CLIENT_ID to be set",
            );
          }
          return new CognitoTokenVerifier({
            issuer: cfg.cognitoIssuer,
            clientId: cfg.cognitoClientId,
          });
        }
        return new DevTokenVerifier();
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [TenantsService],
})
export class AuthModule {}
