export interface ApiConfig {
  port: number;
  databaseUrlApi: string;
  databaseUrlAdmin: string;
  authMode: "dev" | "cognito";
  kmsKeyId: string;
  awsEndpointUrl: string;
  awsRegion: string;
  throttleTtlSeconds: number;
  throttleLimit: number;
  publicSubmitLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: Number(env.PORT ?? 3001),
    databaseUrlApi:
      env.DATABASE_URL_API ?? "postgres://app_api:app_api_dev@localhost:5432/eventform",
    databaseUrlAdmin:
      env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform",
    authMode: env.AUTH_MODE === "cognito" ? "cognito" : "dev",
    kmsKeyId: env.KMS_KEY_ID ?? "alias/eventform-endpoint-secrets",
    // LocalStack KMS is the provider in dev AND prod (on the EC2 it's
    // http://localstack:4566 — set by the Phase 5 compose). Real AWS KMS is
    // not a deployment target; see spec §Endpoint secret encryption.
    awsEndpointUrl: env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    awsRegion: env.AWS_REGION ?? "us-east-1",
    throttleTtlSeconds: Number(env.THROTTLE_TTL_SECONDS ?? 60),
    throttleLimit: Number(env.THROTTLE_LIMIT ?? 120),
    publicSubmitLimit: Number(env.PUBLIC_SUBMIT_THROTTLE_LIMIT ?? 10),
  };
}
