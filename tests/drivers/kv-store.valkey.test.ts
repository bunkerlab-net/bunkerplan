import { expect, test } from "bun:test";
import { VALKEY_URL, valkeyKv } from "./backends.ts";
import { describeKvStore } from "./contract/kv-store.ts";

const skip = VALKEY_URL === undefined;

describeKvStore("Valkey", valkeyKv, { skip });

/**
 * Expiry actually elapsing is only observable here. Workers KV floors a ttl at
 * 60 seconds, so the shared contract can prove a short ttl is accepted but not
 * that it fires; Valkey honours the second it was given.
 *
 * One test rather than four, because the real clock is what it costs: every
 * case needs a key that has outlived its ttl, and splitting them would either
 * buy four waits or share one through a hook.
 *
 * The budget is its own, and deliberately not `FIXTURE_TIMEOUT_MS`: this waits
 * 3s against 2s ttls and runs a handful of commands, so 30s is already far
 * past slow and a hang shows up while someone is still watching. A container
 * starting cold is what the two-minute budget elsewhere is for; nothing here
 * starts one.
 */
test.skipIf(skip)(
  "Valkey expiry: a ttl elapses, and rewriting one replaces it",
  async () => {
    const { subject: kv, unique, close } = await valkeyKv();
    const key = (name: string) => `${unique}:expiry:${name}`;

    try {
      await kv.set(key("permanent"), "kept");

      // Better Auth refreshes a session by writing the record again. A rewrite
      // that dropped the ttl would stop sessions expiring; one that kept the
      // original would kill a session the user just renewed.
      await kv.set(key("extended"), "v1", 2);
      await kv.set(key("extended"), "v2", 60);
      await kv.set(key("unexpired"), "v1", 2);
      await kv.set(key("unexpired"), "v2");

      // The two keys the wait is actually about, written last and read
      // immediately: everything above is out of the way, so the ttl only has
      // to outlast two round trips rather than nine. Readable here means what
      // follows is about expiry rather than a write that never landed.
      await kv.set(key("elapses"), "transient", 2);
      await kv.set(key("alongside"), "dropped", 2);
      expect(await kv.get(key("elapses"))).toBe("transient");
      expect(await kv.get(key("alongside"))).toBe("dropped");

      await Bun.sleep(3_000);

      // The short-lived keys are gone, and only those.
      expect(await kv.get(key("elapses"))).toBeNull();
      expect(await kv.get(key("alongside"))).toBeNull();
      expect(await kv.get(key("permanent"))).toBe("kept");

      // A rewrite carries its own ttl, or none at all - neither inherits the
      // deadline the first write set.
      expect(await kv.get(key("extended"))).toBe("v2");
      expect(await kv.get(key("unexpired"))).toBe("v2");
    } finally {
      await close();
    }
  },
  30_000,
);
