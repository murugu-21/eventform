/**
 * Delivery lifecycle rules (framework-free, pure).
 */

/**
 * Only a `failed` delivery may be manually retried — `pending`/`retrying` are
 * still in flight and `delivered` is terminal-success. Accepts the raw status
 * string so the domain stays decoupled from the persistence row type.
 */
export function canRetryDelivery(status: string): boolean {
  return status === "failed";
}
