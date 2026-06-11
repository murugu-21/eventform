export const MAX_ATTEMPTS = 3;

const DELAYS_MS = [5_000, 30_000];

/** Delay before the NEXT attempt, given the attempt number that just failed; null = terminal. */
export function nextRetryDelayMs(failedAttemptNo: number): number | null {
  if (failedAttemptNo >= MAX_ATTEMPTS) {
    return null;
  }
  return DELAYS_MS[failedAttemptNo - 1] ?? DELAYS_MS[DELAYS_MS.length - 1];
}
