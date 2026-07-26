import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { KvStore } from "../../../src/services/types.ts";
import type { Fixture } from "../backends.ts";

/**
 * The `KvStore` contract, run against Workers KV and Valkey.
 *
 * This is where Better Auth keeps sessions (src/kv/secondary-storage.ts), so
 * the two stores disagreeing is an authentication bug: a session that reads
 * back as absent signs a user out, and one that outlives its ttl signs them
 * in after they logged out. The two are wildly different - an eventually
 * consistent HTTP store and an in-memory database with its own command
 * grammar - and they are held to one set of assertions here.
 */

export function describeKvStore(
  name: string,
  open: () => Promise<Fixture<KvStore>>,
  options: { skip: boolean },
): void {
  describe.skipIf(options.skip)(`KvStore: ${name}`, () => {
    let fixture: Fixture<KvStore>;
    let kv: KvStore;
    let n = 0;

    /** Namespaced per run: Valkey is one long-lived server across suites. */
    const nextKey = (suffix = "") => {
      n += 1;
      return `${fixture.unique}:${n}${suffix}`;
    };

    beforeAll(async () => {
      fixture = await open();
      kv = fixture.subject;
    });

    afterAll(async () => {
      await fixture.close();
    });

    describe("round trip", () => {
      test("get returns what set stored", async () => {
        const key = nextKey();
        await kv.set(key, "session-token");
        expect(await kv.get(key)).toBe("session-token");
      });

      test("set overwrites, including with something shorter", async () => {
        const key = nextKey();
        await kv.set(key, "a-long-original-value");
        await kv.set(key, "short");
        // A store that wrote in place without truncating would return
        // "shortriginal-value" here.
        expect(await kv.get(key)).toBe("short");
      });

      test("get misses for a key that was never set", async () => {
        expect(await kv.get(nextKey())).toBeNull();
      });

      test("delete removes the key", async () => {
        const key = nextKey();
        await kv.set(key, "doomed");
        await kv.delete(key);
        expect(await kv.get(key)).toBeNull();
      });

      test("delete is idempotent and never throws for an absent key", async () => {
        const key = nextKey();
        await kv.delete(key);
        await kv.set(key, "x");
        await kv.delete(key);
        await kv.delete(key);
        expect(await kv.get(key)).toBeNull();
      });

      test("probe resolves against a reachable store", async () => {
        await kv.probe();
      });
    });

    describe("values", () => {
      /**
       * The trap this exists for: `""` is falsy, so a driver that reports a
       * miss with `value || null`, or that treats an empty body as absent,
       * loses the difference between "stored, empty" and "not there".
       */
      test("an empty value is stored, not treated as absent", async () => {
        const key = nextKey();
        await kv.set(key, "");
        expect(await kv.get(key)).toBe("");
      });

      test("a value that looks like RESP framing is data, not commands", async () => {
        const key = nextKey();
        // If ioredis ever interpolated rather than framed its arguments, this
        // would run FLUSHALL against the server instead of being stored.
        const payload = "\r\n*1\r\n$8\r\nFLUSHALL\r\n";
        const canary = nextKey();
        await kv.set(canary, "still-here");
        await kv.set(key, payload);

        expect(await kv.get(key)).toBe(payload);
        expect(await kv.get(canary)).toBe("still-here");
      });

      test.each([
        ["json", '{"session":{"userId":"u1"},"nested":"{\\"a\\":1}"}'],
        ["unicode", "café 🚀 日本語"],
        ["newlines", "line one\nline two\r\nline three"],
        ["nul byte", "before\u0000after"],
        ["quotes and backslashes", `he said "hi" \\ '\\n' `],
      ])("a %s value round-trips exactly", async (_, value) => {
        const key = nextKey();
        await kv.set(key, value);
        expect(await kv.get(key)).toBe(value);
      });

      test("a session-sized value round-trips exactly", async () => {
        const key = nextKey();
        // Comfortably past a real session record, and past the point where
        // either store would chunk it.
        const value = "x".repeat(100_000);
        await kv.set(key, value);
        expect(await kv.get(key)).toBe(value);
      });
    });

    describe("keys", () => {
      test.each([
        ["colon separated", "better-auth:session:abc123"],
        ["slashes", "a/b/c"],
        ["spaces", "key with spaces"],
        ["unicode", "clé-café-🔑"],
        ["percent encoded", "a%2Fb%00c"],
        ["query-like", "k?a=1&b=2#frag"],
      ])("a %s key addresses its own value", async (_, shape) => {
        const key = `${nextKey()}${shape}`;
        await kv.set(key, "mine");
        expect(await kv.get(key)).toBe("mine");
        await kv.delete(key);
        expect(await kv.get(key)).toBeNull();
      });

      /**
       * Valkey addresses keys by glob in several commands, so a driver that
       * ever reached for `KEYS`/`DEL` with a pattern would let one caller's
       * key delete every other. Workers KV has no such grammar, and both must
       * behave the same.
       */
      test("a glob metacharacter in a key matches nothing but itself", async () => {
        const prefix = nextKey();
        const neighbours = [`${prefix}a`, `${prefix}b`, `${prefix}ab`];
        for (const key of neighbours) await kv.set(key, key);

        await kv.set(`${prefix}*`, "literal-star");
        expect(await kv.get(`${prefix}*`)).toBe("literal-star");

        await kv.delete(`${prefix}*`);
        for (const key of neighbours) expect(await kv.get(key)).toBe(key);

        await kv.delete(`${prefix}[ab]`);
        for (const key of neighbours) expect(await kv.get(key)).toBe(key);
      });

      test("keys do not collide by prefix", async () => {
        const prefix = nextKey();
        await kv.set(prefix, "bare");
        await kv.set(`${prefix}:child`, "child");
        await kv.set(`${prefix}extra`, "extra");

        expect(await kv.get(prefix)).toBe("bare");
        expect(await kv.get(`${prefix}:child`)).toBe("child");
        expect(await kv.get(`${prefix}extra`)).toBe("extra");

        await kv.delete(prefix);
        expect(await kv.get(`${prefix}:child`)).toBe("child");
        expect(await kv.get(`${prefix}extra`)).toBe("extra");
      });

      test("a key at the Workers KV 512-byte ceiling still works", async () => {
        const key = nextKey().padEnd(512, "k").slice(0, 512);
        expect(key.length).toBe(512);
        await kv.set(key, "long-key");
        expect(await kv.get(key)).toBe("long-key");
      });
    });

    describe("expiry", () => {
      test("a value set with a ttl is readable inside the window", async () => {
        const key = nextKey();
        await kv.set(key, "fresh", 300);
        expect(await kv.get(key)).toBe("fresh");
      });

      /**
       * Workers KV rejects an `expirationTtl` below 60 seconds outright, and
       * Better Auth hands the session ttl straight through - so a short-lived
       * session would throw on one store and work on the other. The driver
       * raises it to the floor; what both stores owe the caller is that the
       * value is there.
       */
      test("a ttl below the Workers KV floor is accepted, not rejected", async () => {
        const key = nextKey();
        await kv.set(key, "short-lived", 1);
        expect(await kv.get(key)).toBe("short-lived");
      });

      test("setting again without a ttl leaves the value readable", async () => {
        const key = nextKey();
        await kv.set(key, "first", 60);
        await kv.set(key, "second");
        expect(await kv.get(key)).toBe("second");
      });

      test("a ttl does not leak onto a different key", async () => {
        const expiring = nextKey();
        const permanent = nextKey();
        await kv.set(expiring, "goes", 60);
        await kv.set(permanent, "stays");
        expect(await kv.get(permanent)).toBe("stays");
      });
    });

    describe("concurrency", () => {
      test("racing writes to one key settle on one whole value", async () => {
        const key = nextKey();
        const values = Array.from({ length: 16 }, (_, i) => `v${i}`.repeat(64));
        await Promise.all(values.map((value) => kv.set(key, value)));

        const settled = await kv.get(key);
        expect(settled).not.toBeNull();
        expect(values).toContain(settled ?? "");
      });

      test("distinct keys written together stay distinct", async () => {
        const keys = Array.from({ length: 32 }, () => nextKey());
        await Promise.all(keys.map((key) => kv.set(key, `value-${key}`)));

        expect(await Promise.all(keys.map((key) => kv.get(key)))).toEqual(
          keys.map((key) => `value-${key}`),
        );
      });

      test("a delete racing a write leaves the key readable or absent, not stale", async () => {
        const key = nextKey();
        await kv.set(key, "original");

        await Promise.all([kv.set(key, "replacement"), kv.delete(key)]);

        const settled = await kv.get(key);
        expect(settled === null || settled === "replacement").toBe(true);
      });
    });
  });
}
