import type { SecondaryStorage } from "@better-auth/core/db";
import type { KvStore } from "../services/types.ts";

/**
 * Better Auth's `SecondaryStorage` over our `KvStore`. Its `ttl` is already in
 * seconds, so no conversion is needed. One adapter serves both KV drivers.
 *
 * `getAndDelete` and `increment` became required in Better Auth 1.7 and both
 * have to be atomic: `getAndDelete` so a single-use credential cannot be
 * redeemed twice, `increment` so a rate-limit window is decided in one step.
 * Valkey could serve `getAndDelete` with a single `GETDEL`, and `increment`
 * only with a Lua script or a transaction - `INCR` then `EXPIRE` is two
 * commands, and a window whose second command never lands never expires. But
 * this adapter sits above the shared `KvStore` seam and Workers KV offers
 * neither - so there is no implementation here that holds for both drivers,
 * and emulating them with separate calls would look atomic while racing. So
 * this deployment routes both concerns to the database instead -
 * `verification.storeInDatabase` and `rateLimit.storage: "database"` in
 * src/auth/options.ts - which leaves these two unreachable. They refuse rather
 * than pretend: if one ever fires, the configuration moved and the guarantee
 * went with it.
 */
export function toSecondaryStorage(kv: KvStore): SecondaryStorage {
  return {
    get: (key) => kv.get(key),
    set: (key, value, ttl) => kv.set(key, value, ttl),
    delete: (key) => kv.delete(key),
    getAndDelete: () => {
      throw new Error(
        "getAndDelete is not available on this KV store: verification is stored in the database, so Better Auth should never reach for it",
      );
    },
    increment: () => {
      throw new Error(
        "increment is not available on this KV store: rate limits are counted in the database, so Better Auth should never reach for it",
      );
    },
  };
}
