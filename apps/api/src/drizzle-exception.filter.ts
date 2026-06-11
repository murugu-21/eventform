import { ArgumentsHost, Catch, ExceptionFilter, Logger } from "@nestjs/common";
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
 */
@Catch(DrizzleQueryError)
export class DrizzleExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DrizzleExceptionFilter.name);

  catch(err: DrizzleQueryError, host: ArgumentsHost): void {
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
