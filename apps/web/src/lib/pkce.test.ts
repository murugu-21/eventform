import { describe, it, expect, vi, afterEach } from "vitest";
import { generateVerifier, challengeFor, authorizeUrl, exchangeCode } from "./pkce";
import type { CognitoConfig } from "./pkce";

const cfg: CognitoConfig = {
  domain: "https://example.auth.us-east-1.amazoncognito.com",
  clientId: "test-client",
  redirectUri: "http://localhost:5173/auth/callback",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateVerifier", () => {
  it("produces a 43-character base64url string", () => {
    const v = generateVerifier();
    // 32 bytes → 43 base64url chars (no padding)
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces unique values each call", () => {
    const a = generateVerifier();
    const b = generateVerifier();
    expect(a).not.toBe(b);
  });
});

describe("challengeFor", () => {
  it("matches the RFC 7636 S256 test vector", async () => {
    // verifier from RFC 7636 Appendix B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await challengeFor(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("authorizeUrl", () => {
  it("contains all required PKCE + Google IdP params", () => {
    const url = authorizeUrl(cfg, "challenge-abc", "state-xyz");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://example.auth.us-east-1.amazoncognito.com/oauth2/authorize",
    );
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(parsed.searchParams.get("state")).toBe("state-xyz");
    expect(parsed.searchParams.get("identity_provider")).toBe("Google");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
  });
});

describe("exchangeCode", () => {
  it("POSTs the correct form body and returns token response", async () => {
    const mockResponse = {
      access_token: "access-tok",
      id_token: "id-tok",
      refresh_token: "refresh-tok",
      expires_in: 3600,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const result = await exchangeCode(cfg, "auth-code-123", "verifier-abc");
    expect(result).toEqual(mockResponse);

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://example.auth.us-east-1.amazoncognito.com/oauth2/token");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-123");
    expect(body.get("code_verifier")).toBe("verifier-abc");
  });

  it("throws when the token endpoint returns non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    await expect(exchangeCode(cfg, "bad-code", "verifier")).rejects.toThrow(
      "token exchange failed: 400",
    );
  });
});
