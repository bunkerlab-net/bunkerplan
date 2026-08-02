import { Redis } from "ioredis";
import type { KvStore } from "../services/types.ts";
import { MIN_TTL_SECONDS } from "./min-ttl.ts";

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
      // Valkey would honour a shorter TTL exactly, but Workers KV cannot -
      // see src/kv/min-ttl.ts. Both drivers floor so `KvStore.set` means one
      // lifetime everywhere.
      if (ttlSeconds === undefined) await client.set(key, value);
      else {
        await client.set(
          key,
          value,
          "EX",
          Math.max(MIN_TTL_SECONDS, ttlSeconds),
        );
      }
    },

    async delete(key) {
      await client.del(key);
    },

    async probe() {
      /*
       * No abort signal, unlike the Postgres probe. That one takes a client
       * out of a pool and can destroy it alone; this driver holds a single
       * connection for the process, so the only way to abandon a command
       * mid-flight is `disconnect()` - which would drop the reads and writes
       * every other request is making through it. A `PING` that outlasts its
       * caller's patience is cheaper than that.
       */
      await client.ping();
    },

    async close() {
      // `quit` waits for a reply, which a client that is mid-reconnect never
      // sends; this drops the socket and cancels the retry timers with it.
      client.disconnect();
    },
  };
}
