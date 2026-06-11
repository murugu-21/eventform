import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZodValidationPipe } from "../src/zod.pipe";

const schema = z.object({ title: z.string().min(1) }).strict();
const pipe = new ZodValidationPipe(schema);

describe("ZodValidationPipe", () => {
  it("returns the parsed value on success", () => {
    expect(pipe.transform({ title: "hi" })).toEqual({ title: "hi" });
  });

  it("throws BadRequestException with field details on failure", () => {
    try {
      pipe.transform({ title: "" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as Record<string, unknown>;
      expect(JSON.stringify(body.errors)).toContain("title");
    }
  });

  it("rejects unknown keys (strict schemas)", () => {
    expect(() => pipe.transform({ title: "hi", extra: 1 })).toThrow(BadRequestException);
  });
});
