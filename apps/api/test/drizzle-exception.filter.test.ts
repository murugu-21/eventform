import { describe, expect, it, vi } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { HttpException, Logger, NotFoundException } from "@nestjs/common";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { DrizzleExceptionFilter } from "../src/drizzle-exception.filter";

function fakeHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: "/test", method: "POST" }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function drizzleError(pgCode: string): DrizzleQueryError {
  const cause = Object.assign(new Error("db says no"), { code: pgCode, constraint: "fk_x" });
  return new DrizzleQueryError("insert into secret_stuff ...", ["sensitive-param"], cause);
}

describe("DrizzleExceptionFilter", () => {
  it("maps foreign-key violations (23503) to 409", () => {
    const { host, status, json } = fakeHost();
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    new DrizzleExceptionFilter().catch(drizzleError("23503"), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("secret_stuff");
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("sensitive-param");
    const loggedString = warnSpy.mock.calls.map((args) => String(args[0])).join(" ");
    expect(loggedString).not.toContain("secret_stuff");
    expect(loggedString).not.toContain("sensitive-param");
    warnSpy.mockRestore();
  });

  it("maps unique violations (23505) to 409", () => {
    const { host, status } = fakeHost();
    new DrizzleExceptionFilter().catch(drizzleError("23505"), host);
    expect(status).toHaveBeenCalledWith(409);
  });

  it("maps anything else to a sanitized 500", () => {
    const { host, status, json } = fakeHost();
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    new DrizzleExceptionFilter().catch(drizzleError("XX000"), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("secret_stuff");
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain("sensitive-param");
    const loggedString = warnSpy.mock.calls.map((args) => String(args[0])).join(" ");
    expect(loggedString).not.toContain("secret_stuff");
    expect(loggedString).not.toContain("sensitive-param");
    warnSpy.mockRestore();
  });

  it("wraps string HttpException responses like NestJS's default serialisation", () => {
    const { host, status, json } = fakeHost();
    new DrizzleExceptionFilter().catch(new HttpException("slow down", 429), host);
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({ statusCode: 429, message: "slow down" });
  });

  it("passes object HttpException responses through unchanged", () => {
    const { host, status, json } = fakeHost();
    new DrizzleExceptionFilter().catch(new NotFoundException("delivery not found"), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0]).toMatchObject({ statusCode: 404, message: "delivery not found" });
  });

  it("logs unknown errors before returning a sanitized 500", () => {
    const { host, status, json } = fakeHost();
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    new DrizzleExceptionFilter().catch(new TypeError("boom from nowhere"), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: "Internal server error" });
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("boom from nowhere");
    errorSpy.mockRestore();
  });
});
