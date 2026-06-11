import {
  BadRequestException,
  CallHandler,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";
import { Observable } from "rxjs";
import { validationFailure } from "../zod.pipe";
import { validateAnswers } from "./answers";
import { PublicService, ResolvedForm } from "./public.service";
import { submitBodySchema } from "./public.schemas";

interface SubmitRequest extends Request {
  resolvedForm: ResolvedForm;
}

/**
 * Request-validation layer for the public submit path. The body's STATIC
 * shape is already guaranteed by the zod pipe; this interceptor handles the
 * form-dependent rules (required fields, option membership, unknown labels),
 * which need the form definition from the DB. Validation failures (400) are
 * raised here — services only ever throw on DB state (404/409).
 */
@Injectable()
export class AnswersValidationInterceptor implements NestInterceptor {
  constructor(private readonly publicService: PublicService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<SubmitRequest>();
    // resolvePublishedForm throws NotFound for unknown/draft slugs (DB state).
    const form = await this.publicService.resolvePublishedForm(String(req.params.slug));

    // Interceptors run BEFORE pipes, so the static shape must be checked here
    // too; the handler's zod pipe then re-parses the normalized body (idempotent).
    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw validationFailure(parsed.error);
    }
    req.body = parsed.data;

    const errors = validateAnswers(form.fields, parsed.data.answers);
    if (errors.length > 0) {
      throw new BadRequestException({ message: "Validation failed", errors });
    }

    req.resolvedForm = form;
    return next.handle();
  }
}

/** The form resolved (and validated against) by AnswersValidationInterceptor. */
export const ValidatedForm = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedForm =>
    ctx.switchToHttp().getRequest<SubmitRequest>().resolvedForm,
);
