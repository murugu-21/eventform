import { randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/** Webhook signing secret: whsec_ + 48 hex chars (24 random bytes). */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export interface SecretCipherOptions {
  keyId: string;
  /** LocalStack in dev/prod-on-EC2; omit for real AWS KMS. */
  endpoint?: string;
  region?: string;
  client?: KMSClient;
}

/**
 * Encrypts endpoint HMAC secrets with KMS so they are never stored plaintext.
 * EncryptionContext binds each ciphertext to its tenant.
 */
export class SecretCipher {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(opts: SecretCipherOptions) {
    this.keyId = opts.keyId;
    this.client =
      opts.client ??
      new KMSClient({
        region: opts.region ?? "us-east-1",
        ...(opts.endpoint
          ? {
              endpoint: opts.endpoint,
              // LocalStack requires credentials; fall back to "test" stubs when
              // no real credentials are present in the environment.
              credentials:
                process.env.AWS_ACCESS_KEY_ID
                  ? undefined
                  : { accessKeyId: "test", secretAccessKey: "test" },
            }
          : {}),
      });
  }

  async encrypt(plaintext: string, tenantId: string): Promise<string> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(plaintext, "utf8"),
        EncryptionContext: { tenantId },
      }),
    );
    return Buffer.from(out.CiphertextBlob!).toString("base64");
  }

  async decrypt(ciphertextB64: string, tenantId: string): Promise<string> {
    const out = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertextB64, "base64"),
        EncryptionContext: { tenantId },
      }),
    );
    return Buffer.from(out.Plaintext!).toString("utf8");
  }
}
