import type { KvStore } from "../services/types.ts";
import { MIN_TTL_SECONDS } from "./min-ttl.ts";

// KVNamespace is an ambient global from the generated
// worker-configuration.d.ts - see `bun run cf-typegen`.

export function createWorkersKv(namespace: KVNamespace): KvStore {
  return {
    async get(key) {
      return await namespace.get(key, "text");
    },

    async set(key, value, ttlSeconds) {
      await namespace.put(
        key,
        value,
        ttlSeconds === undefined
          ? {}
          : { expirationTtl: Math.max(MIN_TTL_SECONDS, ttlSeconds) },
      );
    },

    async delete(key) {
      await namespace.delete(key);
    },

    async probe() {
      await namespace.get("__healthz__", "text");
    },
  };
}
