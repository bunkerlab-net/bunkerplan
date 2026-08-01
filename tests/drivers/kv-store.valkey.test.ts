import { expect, test } from "bun:test";
import { Redis } from "ioredis";
import { MIN_TTL_SECONDS } from "../../src/kv/min-ttl.ts";
import { VALKEY_URL, valkeyKv } from "./backends.ts";
import { describeKvStore } from "./contract/kv-store.ts";

const skip = VALKEY_URL === undefined;

describeKvStore("Valkey", valkeyKv, { skip });

/**
 * What the driver does with a ttl is only observable here: the shared
 * contract proves a short ttl is accepted, but Workers KV hides the deadline
 * it registered. Valkey reports it over `TTL`, so this is where the floor in
 * src/kv/min-ttl.ts is pinned - both drivers raise a sub-floor ttl rather
 * than honour it, or the same `set` call would mean two lifetimes depending
 * on deployment.
 *
 * Asserted on registered deadlines rather than a real wait: under the floor
 * nothing expires in under a minute, so a test that slept until expiry would
 * cost 60s of wall clock to prove what `TTL` states directly.
 *
 * One test rather than five because the fixture and the raw client are what
 * it costs; every case is one write and one `TTL` read against the same
 * server.
 */
test.skipIf(skip)(
  "Valkey expiry: a ttl is floored and registered, and a rewrite replaces it",
  async () => {
    const { subject: kv, unique, close } = await valkeyKv();
    // Raw client: `KvStore` deliberately has no ttl read, and adding one for
    // a test would put a member on the contract nothing in src/ calls.
    const client = new Redis(VALKEY_URL as string, {
      maxRetriesPerRequest: 3,
    });
    const key = (name: string) => `${unique}:expiry:${name}`;

    try {
      // No ttl means no deadline: -1 is Redis for "exists, never expires".
      await kv.set(key("permanent"), "kept");
      expect(await client.ttl(key("permanent"))).toBe(-1);

      // The floor. A 2s ttl is registered as MIN_TTL_SECONDS, not obeyed -
      // the value must outlive its asked-for deadline, matching Workers KV.
      await kv.set(key("floored"), "transient", 2);
      const floored = await client.ttl(key("floored"));
      expect(floored).toBeGreaterThan(MIN_TTL_SECONDS - 10);
      expect(floored).toBeLessThanOrEqual(MIN_TTL_SECONDS);
      expect(await kv.get(key("floored"))).toBe("transient");

      // Above the floor, the ttl asked for is the ttl registered.
      await kv.set(key("long"), "kept", 300);
      const long = await client.ttl(key("long"));
      expect(long).toBeGreaterThan(290);
      expect(long).toBeLessThanOrEqual(300);

      // Better Auth refreshes a session by writing the record again. A rewrite
      // that dropped the ttl would stop sessions expiring; one that kept the
      // original would kill a session the user just renewed.
      await kv.set(key("extended"), "v1", 90);
      await kv.set(key("extended"), "v2", 300);
      // Bounded like "long" above: a rewrite that kept the first deadline
      // would still clear 90, so only the narrow bound proves 300 landed.
      const extended = await client.ttl(key("extended"));
      expect(extended).toBeGreaterThan(290);
      expect(extended).toBeLessThanOrEqual(300);
      expect(await kv.get(key("extended"))).toBe("v2");

      // And a rewrite with no ttl clears the deadline entirely.
      await kv.set(key("unexpired"), "v1", 90);
      await kv.set(key("unexpired"), "v2");
      expect(await client.ttl(key("unexpired"))).toBe(-1);
      expect(await kv.get(key("unexpired"))).toBe("v2");
    } finally {
      client.disconnect();
      await close();
    }
  },
  30_000,
);
