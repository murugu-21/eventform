export interface ApiConfig {
  port: number;
  corsOrigins: string[];
  databaseUrlApi: string;
  databaseUrlAdmin: string;
  authMode: "dev" | "cognito";
  cognitoIssuer: string;
  cognitoClientId: string;
  trustProxy: boolean;
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
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((o) => o.trim()),
    databaseUrlApi:
      env.DATABASE_URL_API ?? "postgres://app_api:app_api_dev@localhost:5432/eventform",
    databaseUrlAdmin:
      env.DATABASE_URL ?? "postgres://eventform:eventform@localhost:5432/eventform",
    authMode: env.AUTH_MODE === "cognito" ? "cognito" : "dev",
    cognitoIssuer: env.COGNITO_ISSUER ?? "",
    cognitoClientId: env.COGNITO_CLIENT_ID ?? "",
    trustProxy: env.TRUST_PROXY === "1",
    kmsKeyId: env.KMS_KEY_ID ?? "alias/eventform-endpoint-secrets",
    // LocalStack KMS is the encryption provider in dev and prod (in prod the
    // compose network resolves it at http://localstack:4566). Real AWS KMS is
    // not a deployment target.
    awsEndpointUrl: env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    awsRegion: env.AWS_REGION ?? "us-east-1",
    throttleTtlSeconds: Number(env.THROTTLE_TTL_SECONDS ?? 60),
    throttleLimit: Number(env.THROTTLE_LIMIT ?? 120),
    publicSubmitLimit: Number(env.PUBLIC_SUBMIT_THROTTLE_LIMIT ?? 10),
  };
}
