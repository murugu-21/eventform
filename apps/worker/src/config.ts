/** DEV ONLY — fixed 32-byte key so local dev needs no setup. Prod sets SECRET_ENC_KEY. */
const DEV_SECRET_ENC_KEY = Buffer.from("eventform_dev_only_secret_key_32", "utf8").toString("base64");

export interface WorkerConfig {
  port: number;
  databaseUrlWorker: string;
  databaseUrlAdmin: string;
  kafkaBrokers: string[];
  secretEncKey: string;
  webhookTimeoutMs: number;
  retryPollMs: number;
  outboxRetentionHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    port: Number(env.WORKER_PORT ?? 3002),
    // No committed password. Prod sets DATABASE_URL_WORKER (Neon, password from env);
    // local dev connects to the trust-auth dev Postgres password-less.
    databaseUrlWorker:
      env.DATABASE_URL_WORKER ?? "postgres://app_worker@localhost:5432/eventform",
    databaseUrlAdmin:
      env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform",
    kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:29092").split(","),
    // Base64 32-byte AES-256 key for endpoint-secret encryption (SecretCipher).
    // Prod MUST set SECRET_ENC_KEY; the fallback is a fixed DEV-ONLY key.
    secretEncKey: env.SECRET_ENC_KEY ?? DEV_SECRET_ENC_KEY,
    webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS ?? 10000),
    retryPollMs: Number(env.RETRY_POLL_MS ?? 5000),
    outboxRetentionHours: Number(env.OUTBOX_RETENTION_HOURS ?? 24),
  };
}
