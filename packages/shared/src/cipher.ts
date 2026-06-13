import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Webhook signing secret: whsec_ + 48 hex chars (24 random bytes). */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/**
 * Thrown when a ciphertext cannot be decrypted: wrong tenant (AAD mismatch),
 * tampering (GCM auth-tag mismatch), or a malformed blob. Single error type so
 * callers (and tests) don't depend on Node's internal crypto error messages.
 */
export class DecryptError extends Error {
  constructor(message = "ciphertext could not be decrypted") {
    super(message);
    this.name = "DecryptError";
  }
}

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16; // GCM auth tag

export interface SecretCipherOptions {
  /** Base64-encoded 32-byte AES-256 key (env SECRET_ENC_KEY). */
  key: string;
}

/**
 * Encrypts endpoint HMAC secrets with AES-256-GCM so they are never stored in
 * plaintext. The tenant id is bound in as additional authenticated data (AAD),
 * so a ciphertext copied onto another tenant's row fails to decrypt — the same
 * cryptographic tenant isolation KMS EncryptionContext gave us, in-process and
 * with no external dependency. Serialized blob = base64(iv | tag | ciphertext).
 *
 * encrypt/decrypt are async to preserve the call sites' existing contract
 * (they previously awaited a KMS round-trip); the work itself is synchronous.
 */
export class SecretCipher {
  private readonly key: Buffer;

  constructor(opts: SecretCipherOptions) {
    const key = Buffer.from(opts.key, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `SECRET_ENC_KEY must be a base64-encoded ${KEY_BYTES}-byte key (decoded to ${key.length} bytes)`,
      );
    }
    this.key = key;
  }

  async encrypt(plaintext: string, tenantId: string): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    cipher.setAAD(Buffer.from(tenantId, "utf8"));
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
  }

  async decrypt(ciphertextB64: string, tenantId: string): Promise<string> {
    try {
      const raw = Buffer.from(ciphertextB64, "base64");
      if (raw.length < IV_BYTES + TAG_BYTES) {
        throw new Error("ciphertext too short");
      }
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const enc = raw.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv(ALGO, this.key, iv);
      decipher.setAAD(Buffer.from(tenantId, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    } catch {
      throw new DecryptError();
    }
  }
}
