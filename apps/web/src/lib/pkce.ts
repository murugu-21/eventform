function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface CognitoConfig {
  domain: string;   // https://<prefix>.auth.<region>.amazoncognito.com
  clientId: string;
  redirectUri: string;
}

export function authorizeUrl(cfg: CognitoConfig, challenge: string, state: string): string {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    identity_provider: "Google",
  });
  return `${cfg.domain}/oauth2/authorize?${qs}`;
}

export interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCode(
  cfg: CognitoConfig,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const res = await fetch(`${cfg.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  return res.json();
}

export async function refreshTokens(
  cfg: CognitoConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(`${cfg.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`refresh failed: ${res.status}`);
  }
  return res.json();
}
