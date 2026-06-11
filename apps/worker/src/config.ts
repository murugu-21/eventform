export interface WorkerConfig {
  port: number;
  databaseUrlWorker: string;
  databaseUrlAdmin: string;
  kafkaBrokers: string[];
  kmsKeyId: string;
  awsEndpointUrl: string;
  awsRegion: string;
  webhookTimeoutMs: number;
  retryPollMs: number;
  outboxRetentionHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    port: Number(env.WORKER_PORT ?? 3002),
    databaseUrlWorker:
      env.DATABASE_URL_WORKER ?? "postgres://app_worker:app_worker_dev@localhost:5432/eventform",
    databaseUrlAdmin:
      env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform",
    kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:29092").split(","),
    kmsKeyId: env.KMS_KEY_ID ?? "alias/eventform-endpoint-secrets",
    // LocalStack KMS in dev and prod (prod compose resolves it at http://localstack:4566).
    awsEndpointUrl: env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    awsRegion: env.AWS_REGION ?? "us-east-1",
    webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS ?? 10000),
    retryPollMs: Number(env.RETRY_POLL_MS ?? 5000),
    outboxRetentionHours: Number(env.OUTBOX_RETENTION_HOURS ?? 24),
  };
}
