import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { ZodError, ZodType } from "zod";

export function validationFailure(err: ZodError): BadRequestException {
  return new BadRequestException({
    message: "Validation failed",
    errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw validationFailure(err);
      }
      throw err;
    }
  }
}
