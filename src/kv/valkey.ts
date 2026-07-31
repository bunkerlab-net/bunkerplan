import { Redis } from "ioredis";
import type { KvStore } from "../services/types.ts";

/**
 * A `KvStore` that owns a connection, and so can be asked to give it up.
 *
 * The process holds one of these for its lifetime, which is why nothing in
 * `src/` calls `close`. A test process does not: it builds several against one
 * server, and an ioredis client left connected keeps a socket and its
 * reconnect timers alive for as long as the process runs.
 */
export interface ValkeyKv extends KvStore {
  close(): Promise<void>;
}

/**
 * Valkey/Redis over `ioredis`. Node-only - this module MUST NOT be reachable
 * from src/runtime/cloudflare.ts.
 */
export function createValkeyKv(url: string): ValkeyKv {
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

    async probe() {
      await client.ping();
    },

    async close() {
      // `quit` waits for a reply, which a client that is mid-reconnect never
      // sends; this drops the socket and cancels the retry timers with it.
      client.disconnect();
    },
  };
}
