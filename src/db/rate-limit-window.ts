/**
 * The fixed-window arithmetic both rate-limit repos share. The SQL differs per
 * driver; this does not, and a divergence here would mean two deployments
 * enforcing different policy from the same configuration.
 */

/** Seconds left in the window that started at `windowStart`, never below 1. */
export function retryAfterSeconds(
  windowStart: number,
  now: number,
  windowMs: number,
): number {
  return Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
}
