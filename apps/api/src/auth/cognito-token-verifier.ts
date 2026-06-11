import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { TokenVerifier } from "./token-verifier";

export interface CognitoVerifierOptions {
  issuer: string;   // https://cognito-idp.<region>.amazonaws.com/<poolId>
  clientId: string; // app client id — Cognito access tokens carry it as client_id
}

type Jwks = Parameters<typeof jwtVerify>[1];

@Injectable()
export class CognitoTokenVerifier implements TokenVerifier {
  private readonly jwks: Jwks;

  constructor(
    private readonly opts: CognitoVerifierOptions,
    jwks?: Jwks, // test seam
  ) {
    this.jwks =
      jwks ?? (createRemoteJWKSet(new URL(`${opts.issuer}/.well-known/jwks.json`)) as Jwks);
  }

  async verify(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.opts.issuer });
      if (payload.token_use !== "access") {
        throw new Error("token_use must be access");
      }
      if (payload.client_id !== this.opts.clientId) {
        throw new Error("client_id mismatch");
      }
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("missing sub");
      }
      return payload.sub;
    } catch {
      throw new UnauthorizedException("invalid token");
    }
  }
}
