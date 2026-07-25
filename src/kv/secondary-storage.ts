import type { SecondaryStorage } from "@better-auth/core/db";
import type { KvStore } from "../services/types.ts";

/**
 * Better Auth's `SecondaryStorage` over our `KvStore`. Its `ttl` is already in
 * seconds, so no conversion is needed. One adapter serves both KV drivers.
 */
export function toSecondaryStorage(kv: KvStore): SecondaryStorage {
  return {
    get: (key) => kv.get(key),
    set: (key, value, ttl) => kv.set(key, value, ttl),
    delete: (key) => kv.delete(key),
  };
}
