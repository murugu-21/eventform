import { describe, expect, it, beforeAll } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { CognitoTokenVerifier } from "../src/auth/cognito-token-verifier";

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST";
const CLIENT_ID = "test-client-id";

describe("CognitoTokenVerifier", () => {
  let privateKey: CryptoKey;
  let verifier: CognitoTokenVerifier;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey as CryptoKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = "test-kid";
    jwk.alg = "RS256";
    verifier = new CognitoTokenVerifier(
      { issuer: ISSUER, clientId: CLIENT_ID },
      createLocalJWKSet({ keys: [jwk] }),
    );
  });

  function token(claims: Record<string, unknown>, expiresIn = "1h") {
    return new SignJWT({ token_use: "access", client_id: CLIENT_ID, sub: "user-123", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuedAt()
      .setIssuer((claims.iss as string) ?? ISSUER)
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  it("returns the sub for a valid access token", async () => {
    await expect(verifier.verify(await token({}))).resolves.toBe("user-123");
  });

  it("rejects expired tokens", async () => {
    await expect(verifier.verify(await token({}, "-1h"))).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a wrong issuer", async () => {
    await expect(verifier.verify(await token({ iss: "https://evil.example.com" })))
      .rejects.toThrow(UnauthorizedException);
  });

  it("rejects id tokens (token_use must be access)", async () => {
    await expect(verifier.verify(await token({ token_use: "id" })))
      .rejects.toThrow(UnauthorizedException);
  });

  it("rejects a wrong client_id", async () => {
    await expect(verifier.verify(await token({ client_id: "other" })))
      .rejects.toThrow(UnauthorizedException);
  });

  it("rejects garbage", async () => {
    await expect(verifier.verify("not.a.jwt")).rejects.toThrow(UnauthorizedException);
  });
});
