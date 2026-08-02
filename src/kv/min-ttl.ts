/**
 * The TTL floor both KV drivers apply on `set`.
 *
 * The number is Workers KV's: it rejects an `expirationTtl` below 60 seconds
 * outright, so that driver has to raise short TTLs rather than fail the
 * write. Valkey has no such limit, but honouring a shorter TTL there is what
 * made the same `KvStore.set` call mean two different lifetimes depending on
 * deployment - an entry outlived its TTL on Workers and did not on a
 * self-hosted stack. Both drivers floor at this constant so a TTL means the
 * same thing everywhere: a value written with any TTL lives at least this
 * long, and nothing may depend on it being gone sooner.
 */
export const MIN_TTL_SECONDS = 60;
