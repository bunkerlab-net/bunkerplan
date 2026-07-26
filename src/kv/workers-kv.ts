import type { KvStore } from "../services/types.ts";

// KVNamespace is an ambient global from the generated
// worker-configuration.d.ts — see `bun run cf-typegen`.

/** Workers KV rejects `expirationTtl` below 60 seconds. */
const MIN_TTL_SECONDS = 60;

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
