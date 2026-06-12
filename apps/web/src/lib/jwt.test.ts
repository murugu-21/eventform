import { describe, expect, it } from "vitest";
import { decodeJwtPayload, displayNameFromIdToken } from "./jwt";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.signature`;
}

describe("decodeJwtPayload", () => {
  it("decodes a payload", () => {
    expect(decodeJwtPayload(fakeJwt({ sub: "abc" }))).toEqual({ sub: "abc" });
  });

  it("returns null for garbage", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
    expect(decodeJwtPayload("a.b")).toBeNull();
    expect(decodeJwtPayload("a.!!!.c")).toBeNull();
  });
});

describe("displayNameFromIdToken", () => {
  it("prefers name over email", () => {
    expect(
      displayNameFromIdToken(fakeJwt({ name: "Ada Lovelace", email: "ada@example.com" })),
    ).toBe("Ada Lovelace");
  });

  it("falls back to email", () => {
    expect(displayNameFromIdToken(fakeJwt({ email: "ada@example.com" }))).toBe(
      "ada@example.com",
    );
  });

  it("returns null when neither exists or token is invalid", () => {
    expect(displayNameFromIdToken(fakeJwt({ sub: "x" }))).toBeNull();
    expect(displayNameFromIdToken("garbage")).toBeNull();
  });
});
