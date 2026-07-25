import type { KvStore } from "../services/types.ts";

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds remaining in the current window. */
  retryAfter: number;
}

/**
 * Fixed-window counter keyed `rl:{userId}:{floor(now/window)}`.
 *
 * CAVEAT: on Workers KV the counter is best-effort. KV has no atomic increment
 * and concurrent writes to one key are last-write-wins, so a client can exceed
 * the limit under concurrency. That is inherent to using KV for counters and is
 * accepted because KV is the requested backend. Valkey deployments get exact
 * counting via INCR.
 */
export async function checkRateLimit(
  kv: KvStore,
  userId: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const key = `rl:${userId}:${windowStart}`;
  const retryAfter = windowStart + windowSeconds - nowSeconds;

  let count = await kv.increment(key, windowSeconds);
  if (count === null) {
    const current = await kv.get(key);
    const parsed = current === null ? 0 : Number.parseInt(current, 10);
    count = (Number.isNaN(parsed) ? 0 : parsed) + 1;
    await kv.set(key, String(count), windowSeconds);
  }

  return { allowed: count <= max, retryAfter };
}
