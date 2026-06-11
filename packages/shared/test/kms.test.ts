import { describe, expect, it } from "vitest";
import { SecretCipher, generateEndpointSecret } from "../src/kms";

const cipher = new SecretCipher({
  keyId: process.env.KMS_KEY_ID ?? "alias/eventform-endpoint-secrets",
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
});

const TENANT_A = "0d4f9d40-0000-4000-8000-00000000000a";
const TENANT_B = "0d4f9d40-0000-4000-8000-00000000000b";

describe("generateEndpointSecret", () => {
  it("produces whsec_-prefixed 48-hex-char secrets", () => {
    const secret = generateEndpointSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
  });

  it("produces unique secrets", () => {
    expect(generateEndpointSecret()).not.toBe(generateEndpointSecret());
  });
});

describe("SecretCipher", () => {
  it("round-trips a secret for the same tenant", async () => {
    const secret = generateEndpointSecret();
    const ciphertext = await cipher.encrypt(secret, TENANT_A);
    expect(ciphertext).not.toContain(secret);
    await expect(cipher.decrypt(ciphertext, TENANT_A)).resolves.toBe(secret);
  });

  it("fails to decrypt under a different tenant (encryption context)", async () => {
    const ciphertext = await cipher.encrypt(generateEndpointSecret(), TENANT_A);
    await expect(cipher.decrypt(ciphertext, TENANT_B)).rejects.toThrow();
  });
});
