export const TOKEN_VERIFIER = "TOKEN_VERIFIER";

/** Verifies a bearer token and returns the stable subject (cognito_sub). Throws on invalid. */
export interface TokenVerifier {
  verify(token: string): Promise<string>;
}
