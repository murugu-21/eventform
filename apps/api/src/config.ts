/** DEV ONLY — fixed 32-byte key so local dev needs no setup. Prod sets SECRET_ENC_KEY. */
const DEV_SECRET_ENC_KEY = Buffer.from("eventform_dev_only_secret_key_32", "utf8").toString("base64");

export interface ApiConfig {
  port: number;
  corsOrigins: string[];
  databaseUrlApi: string;
  databaseUrlAdmin: string;
  authMode: "dev" | "cognito";
  cognitoIssuer: string;
  cognitoClientId: string;
  trustProxy: number;
  secretEncKey: string;
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
    // Number of proxy hops to trust (prod via tunnel: 2 = cloudflared + caddy).
    trustProxy: Number(env.TRUST_PROXY ?? 0),
    // Base64 32-byte AES-256 key for endpoint-secret encryption (SecretCipher).
    // Prod MUST set SECRET_ENC_KEY; the fallback is a fixed DEV-ONLY key so local
    // dev works with no setup and ciphertexts survive restarts.
    secretEncKey: env.SECRET_ENC_KEY ?? DEV_SECRET_ENC_KEY,
    throttleTtlSeconds: Number(env.THROTTLE_TTL_SECONDS ?? 60),
    throttleLimit: Number(env.THROTTLE_LIMIT ?? 120),
    publicSubmitLimit: Number(env.PUBLIC_SUBMIT_THROTTLE_LIMIT ?? 10),
  };
}
