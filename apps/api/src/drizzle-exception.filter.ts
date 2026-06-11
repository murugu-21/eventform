import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";
import { DrizzleQueryError } from "drizzle-orm/errors";

interface PgError {
  code?: string;
  constraint?: string;
}

const CONFLICT_CODES: Record<string, string> = {
  "23503": "resource is referenced by other records",
  "23505": "resource already exists",
};

/**
 * DrizzleQueryError.message embeds the SQL and params (which can include
 * KMS ciphertexts). This filter keeps that out of responses AND logs —
 * only the pg error code + constraint name are logged.
 *
 * @Catch() with no args catches everything so instanceof mismatches across
 * ESM/CJS module boundaries cannot cause DrizzleQueryErrors to fall through
 * to NestJS's default 500 handler.
 */
@Catch()
export class DrizzleExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DrizzleExceptionFilter.name);

  catch(err: unknown, host: ArgumentsHost): void {
    // Pass HttpExceptions through, matching NestJS's default serialisation:
    // string responses are wrapped as { statusCode, message }.
    if (err instanceof HttpException) {
      const res = host.switchToHttp().getResponse<Response>();
      const status = err.getStatus();
      const body = err.getResponse();
      res
        .status(status)
        .json(typeof body === "string" ? { statusCode: status, message: body } : body);
      return;
    }
    // Detect DrizzleQueryError by shape (handles instanceof mismatches across
    // ESM/CJS module boundaries that can occur in the SWC/vitest transpile env).
    if (err instanceof DrizzleQueryError || (err != null && typeof err === "object" && "query" in err && "params" in err)) {
      this.handleDrizzle(err as DrizzleQueryError, host);
      return;
    }
    // Unknown error → sanitised 500, but log it so failures stay debuggable.
    // Safe to log: only DrizzleQueryError messages embed SQL/params, and those
    // are handled above.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.logger.error(message, stack);
    const res = host.switchToHttp().getResponse<Response>();
    res.status(500).json({ statusCode: 500, message: "Internal server error" });
  }

  private handleDrizzle(err: DrizzleQueryError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<{ url: string; method: string }>();
    const cause = (err.cause ?? {}) as PgError;
    const conflictMessage = cause.code ? CONFLICT_CODES[cause.code] : undefined;

    this.logger.warn(
      `${req.method} ${req.url} db error code=${cause.code ?? "?"} constraint=${cause.constraint ?? "?"}`,
    );

    if (conflictMessage) {
      res.status(409).json({ statusCode: 409, message: conflictMessage });
      return;
    }
    res.status(500).json({ statusCode: 500, message: "Internal server error" });
  }
}
