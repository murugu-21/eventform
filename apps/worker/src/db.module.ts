import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { createPool } from "@eventform/db";
import { SecretCipher } from "@eventform/shared";
import { loadConfig } from "./config";

export const WORKER_POOL = "WORKER_POOL";
export const SECRET_CIPHER = "SECRET_CIPHER";

@Global()
@Module({
  providers: [
    {
      provide: WORKER_POOL,
      useFactory: (): Pool => createPool(loadConfig().databaseUrlWorker),
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
  exports: [WORKER_POOL, SECRET_CIPHER],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(WORKER_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
