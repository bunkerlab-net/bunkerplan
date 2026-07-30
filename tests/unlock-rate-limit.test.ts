import { describe, expect, test } from "bun:test";
import { unlockPlan } from "../src/client/api.ts";
import {
  chargeUnlockAttempt,
  checkUnlockRate,
} from "../src/http/unlock-rate-limit.ts";
import type { RateLimitRepo } from "../src/services/types.ts";

const CONFIG = {
  clientIpHeader: "cf-connecting-ip",
  // Keys the bucket digest; any stable value serves here.
  secret: "test-secret-at-least-32-characters-long",
  unlockRateMax: 3,
  unlockRateWindowSec: 60,
};

/**
 * Records what bucket was touched, and separately what was spent.
 *
 * Both halves record a key: the gate reads the budget through `peek` and only a
 * refused attempt reaches `consume`. Every claim below - the digest, the
 * ceiling, one bucket per address - is meant to hold of either.
 */
function fakeLimits(allowed: boolean, retryAfter = 42) {
  const keys: string[] = [];
  const spent: string[] = [];
  const limits: RateLimitRepo = {
    consume: async (key) => {
      keys.push(key);
      spent.push(key);
      return { allowed, retryAfter };
    },
    peek: async (key) => {
      keys.push(key);
      return { allowed, retryAfter };
    },
  };
  return { limits, keys, spent };
}

const post = (headers: Record<string, string> = {}) =>
  new Request("https://plans.example.test/api/plans/abc/unlock", {
    method: "POST",
    headers,
    body: JSON.stringify({ code: "x" }),
  });

/**
 * The bucket a passed gate handed back, or a failure naming what came instead.
 *
 * The result is a union, and every test below wants one side or the other. This
 * asserts which rather than reaching into `unknown`, so a gate that started
 * refusing reads as that rather than as `undefined` somewhere later.
 */
const bucketOf = async (
  ...args: Parameters<typeof checkUnlockRate>
): Promise<string> => {
  const budget = await checkUnlockRate(...args);
  if ("refused" in budget) {
    throw new Error(`gate refused with ${budget.refused.status}`);
  }
  return budget.bucket;
};

/** The refusal a closed gate produced, asserted as one. */
const refusalOf = async (
  ...args: Parameters<typeof checkUnlockRate>
): Promise<Response> => {
  const budget = await checkUnlockRate(...args);
  if (!("refused" in budget)) throw new Error("gate allowed the request");
  return budget.refused;
};

describe("the unlock rate limit", () => {
  test("charges a digest of the address, never the address itself", async () => {
    // The bucket is the address, so one address cannot spend another address's
    // allowance - callers sharing one still share it. The stored key is a keyed
    // digest, so this table is not a log of every address that poked a link.
    const { limits, keys } = fakeLimits(true);
    const bucket = await bucketOf(
      limits,
      CONFIG,
      post({ "cf-connecting-ip": "203.0.113.9" }),
    );

    expect(keys).toEqual([bucket]);
    expect(bucket).not.toContain("203.0.113.9");
    expect(bucket).toMatch(/^[0-9a-f]{64}$/);
  });

  test("passes the configured ceiling and window through", async () => {
    const seen: Array<[number, number]> = [];
    const answer = async (_key: string, max: number, window: number) => {
      seen.push([max, window]);
      return { allowed: true, retryAfter: 0 };
    };
    const limits: RateLimitRepo = { consume: answer, peek: answer };

    const bucket = await bucketOf(
      limits,
      CONFIG,
      post({ "cf-connecting-ip": "a" }),
    );
    expect(seen).toEqual([[3, 60]]);

    // The charge reads the same two, or a refusal would be rationed against a
    // window the gate never used.
    await chargeUnlockAttempt(limits, CONFIG, bucket);
    expect(seen).toEqual([
      [3, 60],
      [3, 60],
    ]);
  });

  test("the gate spends nothing, which is what makes a correct code free", async () => {
    const { limits, keys, spent } = fakeLimits(true);

    await bucketOf(limits, CONFIG, post({ "cf-connecting-ip": "a" }));

    // Asked, and not charged. A link opened by everyone it was sent to is the
    // normal case, and charging those locked out a room behind one address.
    expect(keys).toHaveLength(1);
    expect(spent).toEqual([]);
  });

  test("a refused attempt spends, against the bucket the gate read", async () => {
    const { limits, keys, spent } = fakeLimits(true);
    const request = post({ "cf-connecting-ip": "203.0.113.9" });

    const bucket = await bucketOf(limits, CONFIG, request);
    await chargeUnlockAttempt(limits, CONFIG, bucket);

    /*
     * The same bucket, and now by construction: the gate hands its key back and
     * the charge takes one, so there is no second read of the header and no
     * second HMAC that could disagree. What is left to assert is that the value
     * travelled - two touches, one spend, one key.
     */
    expect(keys).toEqual([bucket, bucket]);
    expect(spent).toEqual([bucket]);
  });

  test("buckets one address together and two apart", async () => {
    const charge = async (address: string) => {
      const { limits, keys } = fakeLimits(true);
      await checkUnlockRate(
        limits,
        CONFIG,
        post({ "cf-connecting-ip": address }),
      );
      return keys[0] ?? "";
    };

    // Deterministic, or an address would get a fresh allowance per request.
    expect(await charge("203.0.113.9")).toBe(await charge("203.0.113.9"));
    // Distinct, or one address could spend another's.
    expect(await charge("203.0.113.9")).not.toBe(await charge("203.0.113.10"));
  });

  test("answers 429 with retry-after once the allowance is spent", async () => {
    const { limits } = fakeLimits(false, 17);
    const refused = await refusalOf(
      limits,
      CONFIG,
      post({ "cf-connecting-ip": "203.0.113.9" }),
    );

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("17");
  });

  test("reads the header the configuration names, not a fixed one", async () => {
    // A self-hosted deployment names its own; trusting `cf-connecting-ip`
    // behind an nginx that does not set it would bucket every caller together.
    const named = fakeLimits(true);
    await checkUnlockRate(
      named.limits,
      { ...CONFIG, clientIpHeader: "x-forwarded-for" },
      post({ "x-forwarded-for": "198.51.100.4", "cf-connecting-ip": "wrong" }),
    );

    // The digest of the named header's value, not of the other one.
    const expected = fakeLimits(true);
    await checkUnlockRate(
      expected.limits,
      CONFIG,
      post({ "cf-connecting-ip": "198.51.100.4" }),
    );
    expect(named.keys).toEqual(expected.keys);
  });

  test("refuses when the trusted header did not arrive", async () => {
    // Nothing identifies the caller, so there is no bucket to charge. The
    // alternative is one shared bucket for everyone, which is the lockout the
    // per-address keying exists to avoid.
    //
    // And there is nothing to charge it with either: the gate hands a bucket
    // back only on the path that passed, so a refused caller cannot reach
    // `chargeUnlockAttempt` at all - which is now a matter of type rather than
    // of the handler remembering.
    const { limits, keys } = fakeLimits(true);

    expect((await refusalOf(limits, CONFIG, post())).status).toBe(429);
    expect(keys).toEqual([]);
  });

  test("refuses a blank header rather than charging an empty bucket", async () => {
    const { limits, keys } = fakeLimits(true);

    const refused = await refusalOf(
      limits,
      CONFIG,
      post({ "cf-connecting-ip": "" }),
    );

    expect(refused.status).toBe(429);
    expect(keys).toEqual([]);
  });
});

/**
 * What the gate page shows for a 429. The server always sends `retry-after`,
 * so the fallback is for a proxy that strips it - untestable through the real
 * stack, which is why it is asserted here.
 */
describe("the message a throttled reader sees", () => {
  const withFetch = async (response: Response): Promise<string> => {
    const original = globalThis.fetch;
    // `Object.assign` rather than a cast: Bun's `fetch` carries statics like
    // `preconnect`, and the stub has to satisfy the same type.
    globalThis.fetch = Object.assign(async () => response, {
      preconnect: original.preconnect,
    });
    try {
      await unlockPlan("abc", "code");
      return "no error thrown";
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    } finally {
      globalThis.fetch = original;
    }
  };

  test("names the wait when retry-after says how long", async () => {
    const message = await withFetch(
      new Response(JSON.stringify({ error: "rate limit exceeded" }), {
        status: 429,
        headers: { "retry-after": "45" },
      }),
    );

    // Not the bare "rate limit exceeded" the body carries: that tells someone
    // who mistyped a code nothing they can act on.
    expect(message).toBe("Too many attempts. Try again in 45 seconds.");
  });

  test("still says something actionable with no retry-after", async () => {
    const message = await withFetch(
      new Response(JSON.stringify({ error: "rate limit exceeded" }), {
        status: 429,
      }),
    );

    expect(message).toBe("Too many attempts. Try again shortly.");
  });

  test("falls back rather than printing NaN seconds", async () => {
    const message = await withFetch(
      new Response(null, { status: 429, headers: { "retry-after": "soon" } }),
    );

    expect(message).toBe("Too many attempts. Try again shortly.");
  });
});
