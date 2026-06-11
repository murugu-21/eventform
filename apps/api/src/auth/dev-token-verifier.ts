import { Injectable, UnauthorizedException } from "@nestjs/common";
import { TokenVerifier } from "./token-verifier";

const DEV_TOKEN_RE = /^dev_([A-Za-z0-9_-]{1,64})$/;

@Injectable()
export class DevTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<string> {
    const match = DEV_TOKEN_RE.exec(token);
    if (!match) {
      throw new UnauthorizedException("invalid token");
    }
    return match[1];
  }
}
