import { Redis } from "ioredis";
import type { KvStore } from "../services/types.ts";

/**
 * Valkey/Redis over `ioredis`. Node-only — this module MUST NOT be reachable
 * from src/runtime/cloudflare.ts.
 */
export function createValkeyKv(url: string): KvStore {
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });

  return {
    async get(key) {
      return await client.get(key);
    },

    async set(key, value, ttlSeconds) {
      if (ttlSeconds === undefined) await client.set(key, value);
      else await client.set(key, value, "EX", ttlSeconds);
    },

    async delete(key) {
      await client.del(key);
    },

    // Genuinely atomic here. `EXPIRE … NX` only sets the TTL on the first
    // increment of a window, so the window does not slide forward.
    async increment(key, ttlSeconds) {
      const count = await client.incr(key);
      await client.expire(key, ttlSeconds, "NX");
      return count;
    },

    async probe() {
      await client.ping();
    },
  };
}
