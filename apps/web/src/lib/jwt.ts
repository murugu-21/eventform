/**
 * Decode a JWT payload WITHOUT verification — only for reading display claims
 * from tokens we just received first-hand from Cognito over TLS (the API
 * independently verifies signatures on every request; nothing security-relevant
 * may ever depend on this).
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
    const payload: unknown = JSON.parse(json);
    return typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Best display name from an OIDC ID token: name → email → null. */
export function displayNameFromIdToken(idToken: string): string | null {
  const payload = decodeJwtPayload(idToken);
  if (!payload) {
    return null;
  }
  const name = payload.name;
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }
  const email = payload.email;
  if (typeof email === "string" && email.trim().length > 0) {
    return email.trim();
  }
  return null;
}
