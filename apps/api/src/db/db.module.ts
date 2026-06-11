import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { SecretCipher } from "@eventform/shared";
import { loadConfig } from "../config";

export const API_POOL = "API_POOL";
export const SECRET_CIPHER = "SECRET_CIPHER";

@Global()
@Module({
  providers: [
    {
      provide: API_POOL,
      useFactory: (): Pool => createPool(loadConfig().databaseUrlApi),
    },
    {
      provide: SECRET_CIPHER,
      useFactory: (): SecretCipher => {
        const cfg = loadConfig();
        return new SecretCipher({
          keyId: cfg.kmsKeyId,
          endpoint: cfg.awsEndpointUrl,
          region: cfg.awsRegion,
        });
      },
    },
  ],
  exports: [API_POOL, SECRET_CIPHER],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(API_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
