import { describe, expect, test } from "bun:test";
import { toSecondaryStorage } from "../src/kv/secondary-storage.ts";
import type { KvStore } from "../src/services/types.ts";

/**
 * The adapter Better Auth stores sessions through, which is the only thing
 * standing between a `ttl` in seconds and whatever the two KV drivers do with
 * it.
 *
 * Nothing else asserts on it: the drivers have contract suites, and Better
 * Auth is trusted to call this correctly, so a mistake in the three lines
 * between them is invisible from both sides. The `ttl` is the reason this file
 * exists - a conversion added here, or an argument dropped, is a session
 * lifetime wrong by a factor of a thousand or a session that never expires,
 * and every existing test would still pass.
 */

interface Call {
  method: "get" | "set" | "delete";
  args: unknown[];
}

/** Records the exact arguments, so a dropped or rewritten one is visible. */
function recordingKv(over: Partial<KvStore> = {}): {
  kv: KvStore;
  calls: Call[];
} {
  const calls: Call[] = [];
  const kv: KvStore = {
    get: async (...args) => {
      calls.push({ method: "get", args });
      return null;
    },
    set: async (...args) => {
      calls.push({ method: "set", args });
    },
    delete: async (...args) => {
      calls.push({ method: "delete", args });
    },
    // Part of `KvStore` but not of the adapter's surface: Better Auth never
    // health-checks the session store, so this is here to satisfy the type and
    // to fail loudly if the adapter ever starts reaching for it.
    probe: async () => {
      throw new Error("the adapter must not probe the store");
    },
    ...over,
  };
  return { kv, calls };
}

describe("toSecondaryStorage", () => {
  test("reads through to the store under the key it was given", async () => {
    const { kv, calls } = recordingKv();

    await toSecondaryStorage(kv).get("sess:1");

    expect(calls).toEqual([{ method: "get", args: ["sess:1"] }]);
  });

  test("hands back what the store found", async () => {
    const { kv } = recordingKv({ get: async () => "session-json" });

    expect(await toSecondaryStorage(kv).get("sess:1")).toBe("session-json");
  });

  test("writes the key, value and ttl through unchanged", async () => {
    const { kv, calls } = recordingKv();

    await toSecondaryStorage(kv).set("sess:1", "session-json", 300);

    // 300, not 300_000 and not 0. Better Auth's ttl is already in seconds and
    // `KvStore.set` takes seconds, so the correct conversion is none.
    expect(calls).toEqual([
      { method: "set", args: ["sess:1", "session-json", 300] },
    ]);
  });

  test("deletes the key it was given", async () => {
    const { kv, calls } = recordingKv();

    await toSecondaryStorage(kv).delete("sess:1");

    expect(calls).toEqual([{ method: "delete", args: ["sess:1"] }]);
  });

  /**
   * A miss is `null`, and it has to stay `null` rather than becoming
   * `undefined` on the way out: Better Auth branches on the absent session,
   * and the two are not the same value to a strict check.
   */
  test("a miss stays null", async () => {
    const { kv } = recordingKv({ get: async () => null });

    expect(await toSecondaryStorage(kv).get("absent")).toBeNull();
  });

  /**
   * No ttl means no deadline, which both drivers spell as the argument being
   * absent. Passing `0` instead would be a value with meaning - see
   * src/kv/min-ttl.ts, where the floor is applied - so the adapter must not
   * invent one.
   */
  test("an absent ttl is forwarded as absent, not as zero", async () => {
    const { kv, calls } = recordingKv();

    await toSecondaryStorage(kv).set("sess:1", "v");

    expect(calls).toEqual([
      { method: "set", args: ["sess:1", "v", undefined] },
    ]);
  });

  /**
   * A store that is down must surface as a rejection. Swallowing it into a
   * `null` would tell Better Auth the session does not exist, which logs
   * every reader out and reads as expiry rather than as an outage.
   */
  test("a failing read rejects rather than reading as a miss", async () => {
    const failure = new Error("kv unreachable");
    const { kv } = recordingKv({
      get: async () => {
        throw failure;
      },
    });

    await expect(toSecondaryStorage(kv).get("sess:1")).rejects.toThrow(failure);
  });

  test("a failing write rejects rather than passing silently", async () => {
    const failure = new Error("kv unreachable");
    const { kv } = recordingKv({
      set: async () => {
        throw failure;
      },
    });

    await expect(toSecondaryStorage(kv).set("sess:1", "v", 60)).rejects.toThrow(
      failure,
    );
  });

  /**
   * The adapter is a pass-through and must not become a namespace. A prefix
   * added here would orphan every session already stored, and the symptom is
   * a deployment where everyone is logged out once and nobody can say why.
   */
  test.each([
    ["an empty key", ""],
    ["a key holding the driver's own separator", "sess:1:2"],
    ["a key holding whitespace and unicode", " sess \u{1f512}"],
    ["a long key", `sess:${"x".repeat(512)}`],
  ])("passes %s through untouched", async (_label, key) => {
    const { kv, calls } = recordingKv();
    const storage = toSecondaryStorage(kv);

    await storage.get(key);
    await storage.set(key, "v", 1);
    await storage.delete(key);

    expect(calls.map((c) => c.args[0])).toEqual([key, key, key]);
  });

  /** An empty value is a value, and must not be turned into a delete. */
  test("stores an empty value as a write", async () => {
    const { kv, calls } = recordingKv();

    await toSecondaryStorage(kv).set("sess:1", "", 60);

    expect(calls).toEqual([{ method: "set", args: ["sess:1", "", 60] }]);
  });
});
