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

/**
 * How often the unlock bucket also sweeps its closed windows. One in sixteen
 * keeps the table at about its live size while leaving the common request a
 * single write.
 *
 * Not every request: the unlock counter is the one whose key an attacker can
 * change at will, and a rotating address gets a fresh bucket by definition.
 * Sweeping unconditionally would double the writes on exactly the path the
 * per-address cap cannot bound, so the limiter would amplify the load it exists
 * to limit. Each row still only needs deleting once, so the work is the same
 * overall; it is just not charged to every caller.
 *
 * Shared so the two dialects cannot drift into different housekeeping.
 */
const SWEEP_IN = 16;

/** `Math.random` is enough: nothing here depends on being unpredictable. */
export const sometimes = (): boolean => Math.random() < 1 / SWEEP_IN;
