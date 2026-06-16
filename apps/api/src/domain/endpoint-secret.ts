import { generateEndpointSecret } from "@eventform/shared";

/**
 * Webhook signing secret as a value object: an immutable `whsec_`-prefixed
 * token. Constructing it only via `generate()` keeps "this string is a webhook
 * secret" a named concept at call sites rather than a bare `string`. It wraps
 * the shared generator so the format has a single source of truth.
 */
export class EndpointSecret {
  static readonly PREFIX = "whsec_";

  private constructor(public readonly value: string) {}

  static generate(): EndpointSecret {
    return new EndpointSecret(generateEndpointSecret());
  }

  toString(): string {
    return this.value;
  }
}
