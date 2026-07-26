import { beforeAll, describe, expect, test } from "bun:test";
import type { KvStore } from "../../src/services/types.ts";
import { VALKEY_URL, valkeyKv } from "./backends.ts";
import { describeKvStore } from "./contract/kv-store.ts";

const skip = VALKEY_URL === undefined;

describeKvStore("Valkey", valkeyKv, { skip });

/**
 * Expiry actually elapsing is only observable here. Workers KV floors a ttl at
 * 60 seconds, so the shared contract can prove a short ttl is accepted but not
 * that it fires; Valkey honours the second it was given.
 *
 * This is the one place in the suite that waits on the real clock, and it has
 * to: the deadline is held by the Valkey server, so no amount of fake timers
 * in this process moves it. One `EX 1` is set up for every case, then a single
 * wait covers all of them - the cost is ~1.2s for the block, not per test.
 */
describe.skipIf(skip)("KvStore: Valkey expiry", () => {
  let kv: KvStore;
  let unique = "";
  const key = (name: string) => `${unique}:expiry:${name}`;

  beforeAll(async () => {
    const fixture = await valkeyKv();
    kv = fixture.subject;
    unique = fixture.unique;

    await kv.set(key("elapses"), "transient", 1);
    await kv.set(key("permanent"), "kept");
    await kv.set(key("alongside"), "dropped", 1);

    // Better Auth refreshes a session by writing the record again. A rewrite
    // that dropped the ttl would stop sessions expiring; one that kept the
    // original would kill a session the user just renewed.
    await kv.set(key("extended"), "v1", 1);
    await kv.set(key("extended"), "v2", 30);
    await kv.set(key("unexpired"), "v1", 1);
    await kv.set(key("unexpired"), "v2");

    // Every key above is readable now; the assertions below are about what
    // survives, so this proves the one-second keys started out present.
    expect(await kv.get(key("elapses"))).toBe("transient");
    expect(await kv.get(key("alongside"))).toBe("dropped");

    await Bun.sleep(1_200);
  });

  test("a key set with a one-second ttl is gone afterwards", async () => {
    expect(await kv.get(key("elapses"))).toBeNull();
  });

  test("a key set without a ttl outlives one that has one", async () => {
    expect(await kv.get(key("alongside"))).toBeNull();
    expect(await kv.get(key("permanent"))).toBe("kept");
  });

  test("rewriting with a longer ttl extends the key", async () => {
    expect(await kv.get(key("extended"))).toBe("v2");
  });

  test("rewriting without a ttl makes the key permanent", async () => {
    expect(await kv.get(key("unexpired"))).toBe("v2");
  });
});
