import { describe, expect, it } from "vitest";
import { DecryptError, SecretCipher, generateEndpointSecret } from "../src/cipher";

// Fixed 32-byte test key (base64). In-process AES-256-GCM — no LocalStack/KMS.
const TEST_KEY = Buffer.from("eventform_test_only_secret_key32", "utf8").toString("base64");
const cipher = new SecretCipher({ key: TEST_KEY });

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
  it("rejects a key that isn't 32 bytes", () => {
    expect(() => new SecretCipher({ key: Buffer.from("too short").toString("base64") })).toThrow();
  });

  it("round-trips a secret for the same tenant", async () => {
    const secret = generateEndpointSecret();
    const ciphertext = await cipher.encrypt(secret, TENANT_A);
    expect(ciphertext).not.toContain(secret);
    await expect(cipher.decrypt(ciphertext, TENANT_A)).resolves.toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const secret = generateEndpointSecret();
    const a = await cipher.encrypt(secret, TENANT_A);
    const b = await cipher.encrypt(secret, TENANT_A);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt under a different tenant (AAD binding)", async () => {
    const ciphertext = await cipher.encrypt(generateEndpointSecret(), TENANT_A);
    await expect(cipher.decrypt(ciphertext, TENANT_B)).rejects.toThrow(DecryptError);
  });

  it("rejects a tampered ciphertext", async () => {
    const ciphertext = await cipher.encrypt(generateEndpointSecret(), TENANT_A);
    const raw = Buffer.from(ciphertext, "base64");
    raw[Math.floor(raw.length / 2)] ^= 0xff;
    await expect(cipher.decrypt(raw.toString("base64"), TENANT_A)).rejects.toThrow(DecryptError);
  });
});
