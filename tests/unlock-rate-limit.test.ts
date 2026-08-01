import { beforeEach, describe, expect, test } from "bun:test";
import { unlockPlan } from "../src/client/api.ts";
import { createUnlockRoute } from "../src/http/unlock.ts";
import {
  refundUnlockAttempt,
  reserveUnlockAttempt,
  type UnlockRateConfig,
} from "../src/http/unlock-rate-limit.ts";
import type { Logger } from "../src/log.ts";
import type { RateLimitRepo } from "../src/services/types.ts";
import { memoryPlans } from "./fakes.ts";

const CONFIG = {
  clientIpHeader: "cf-connecting-ip",
  // Keys the bucket digest; any stable value serves here.
  secret: "test-secret-at-least-32-characters-long",
  unlockRateMax: 3,
  unlockRateWindowSec: 60,
};

/** The gate config plus what `unlockPlan`'s cookie mint needs, for the route. */
const ROUTE_CONFIG = {
  ...CONFIG,
  publicBaseUrl: "https://plans.example.test",
};

const WINDOW_START = 1_700_000_000_000;

/** Records the bucket each half was called with, so the keying is asserted. */
function fakeLimits(allowed: boolean, retryAfter = 42) {
  const spent: string[] = [];
  const returned: Array<[string, number]> = [];
  const limits: RateLimitRepo = {
    consume: async (key) => {
      spent.push(key);
      return allowed
        ? { allowed: true, retryAfter, windowStart: WINDOW_START }
        : { allowed: false, retryAfter };
    },
    refund: async (key, windowStart) => {
      returned.push([key, windowStart]);
    },
  };
  return { limits, spent, returned };
}

const post = (headers: Record<string, string> = {}) =>
  new Request("https://plans.example.test/api/plans/abc/unlock", {
    method: "POST",
    headers,
    body: JSON.stringify({ code: "x" }),
  });

/**
 * What the route logged. The gate itself no longer takes a logger - it
 * reports `reason` instead - so this belongs to the route describe below.
 *
 * `Pick<Logger, "warn">`, the parameter's own type, rather than a cast: a
 * double that stops matching the signature should fail here at compile time
 * instead of being asserted into place.
 */
const warnings: Array<{ fields: unknown; message: string }> = [];

const logger: Pick<Logger, "warn"> = {
  warn: (fields: unknown, message?: string) => {
    warnings.push({ fields, message: message ?? "" });
  },
};

beforeEach(() => {
  warnings.length = 0;
});

/** The three arguments the gate now takes; the logger moved to the route. */
type GateArgs = [RateLimitRepo, UnlockRateConfig, Request];

/**
 * The reservation a passed gate handed back, or a failure naming what came
 * instead. The result is a union and every test below wants one side or the
 * other, so a gate that started refusing reads as that rather than as
 * `undefined` somewhere later.
 */
const reservationOf = async (
  ...args: GateArgs
): Promise<{ bucket: string; windowStart: number }> => {
  const held = await reserveUnlockAttempt(...args);
  if ("refused" in held) {
    throw new Error(`gate refused with ${held.refused.status}`);
  }
  return held;
};

/** The refusal a closed gate produced, asserted as one. */
const refusalOf = async (
  ...args: GateArgs
): Promise<{
  refused: Response;
  reason: "no-client-address" | "budget-spent";
}> => {
  const held = await reserveUnlockAttempt(...args);
  if (!("refused" in held)) throw new Error("gate allowed the request");
  return held;
};

describe("the unlock rate limit", () => {
  test("charges a digest of the address, never the address itself", async () => {
    // The bucket is the address, so one address cannot spend another address's
    // allowance - callers sharing one still share it. The stored key is a keyed
    // digest, so this table is not a log of every address that poked a link.
    const { limits, spent } = fakeLimits(true);
    const held = await reservationOf(
      limits,
      CONFIG,
      post({ "cf-connecting-ip": "203.0.113.9" }),
    );

    expect(spent).toEqual([held.bucket]);
    expect(held.bucket).not.toContain("203.0.113.9");
    expect(held.bucket).toMatch(/^[0-9a-f]{64}$/);
  });

  test("passes the configured ceiling and window through", async () => {
    const seen: Array<[number, number]> = [];
    const limits: RateLimitRepo = {
      consume: async (_key, max, window) => {
        seen.push([max, window]);
        return { allowed: true, retryAfter: 0, windowStart: WINDOW_START };
      },
      refund: async () => {},
    };

    await reservationOf(limits, CONFIG, post({ "cf-connecting-ip": "a" }));

    expect(seen).toEqual([[3, 60]]);
  });

  test("spends before the code is compared, which is what makes the limit real", async () => {
    const { limits, spent } = fakeLimits(true);

    const held = await reservationOf(
      limits,
      CONFIG,
      post({ "cf-connecting-ip": "a" }),
    );

    /*
     * The reservation is the whole point of this order. Reading the budget
     * without taking from it bounds nothing: concurrent callers all pass such a
     * read before one write lands, so a parallel guesser would meet no limit.
     */
    expect(spent).toEqual([held.bucket]);
    expect(held.windowStart).toBe(WINDOW_START);
  });

  test("a redemption gives its count back, to the window that took it", async () => {
    const { limits, spent, returned } = fakeLimits(true);
    const request = post({ "cf-connecting-ip": "203.0.113.9" });

    const held = await reservationOf(limits, CONFIG, request);
    await refundUnlockAttempt(limits, held);

    // One spend, one return, both naming the same bucket - and the window named
    // too, so a refund cannot land on a budget somebody else opened.
    expect(spent).toEqual([held.bucket]);
    expect(returned).toEqual([[held.bucket, WINDOW_START]]);
  });

  test("a refund that fails reaches the caller rather than being swallowed", async () => {
    /*
     * The one sign refunds are failing at all. Containment lives at the call
     * site in src/app.ts, which catches this and logs it - so a redemption
     * still answers 200, and an operator still learns the budget is drifting
     * down. Swallowing it here would take the log with it.
     */
    const { limits } = fakeLimits(true);
    const held = await reservationOf(
      limits,
      CONFIG,
      post({ "cf-connecting-ip": "203.0.113.9" }),
    );
    // A second repo rather than a write onto the first: the reservation is
    // taken from one that works, and the refund offered to one that does not,
    // which is the shape the failure actually has.
    const unreachable = new Error("the counter store is unreachable");
    const failing: RateLimitRepo = {
      ...limits,
      refund: async () => {
        throw unreachable;
      },
    };

    await expect(refundUnlockAttempt(failing, held)).rejects.toBe(unreachable);
  });

  test("buckets one address together and two apart", async () => {
    const bucketFrom = async (address: string) => {
      const { limits } = fakeLimits(true);
      const held = await reservationOf(
        limits,
        CONFIG,
        post({ "cf-connecting-ip": address }),
      );
      return held.bucket;
    };

    // Deterministic, or an address would get a fresh allowance per request.
    expect(await bucketFrom("203.0.113.9")).toBe(
      await bucketFrom("203.0.113.9"),
    );
    // Distinct, or one address could spend another's.
    expect(await bucketFrom("203.0.113.9")).not.toBe(
      await bucketFrom("203.0.113.10"),
    );
  });

  test("answers 429 with retry-after once the allowance is spent", async () => {
    const { limits } = fakeLimits(false, 17);
    const { refused, reason } = await refusalOf(
      limits,
      CONFIG,
      post({ "cf-connecting-ip": "203.0.113.9" }),
    );

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("17");
    // The two refusals are the same status and the caller cannot tell them
    // apart, which is deliberate - the reason is how the route can.
    expect(reason).toBe("budget-spent");
  });

  test("reads the header the configuration names, not a fixed one", async () => {
    // A self-hosted deployment names its own; trusting `cf-connecting-ip`
    // behind an nginx that does not set it would bucket every caller together.
    const named = fakeLimits(true);
    await reservationOf(
      named.limits,
      { ...CONFIG, clientIpHeader: "x-forwarded-for" },
      post({ "x-forwarded-for": "198.51.100.4", "cf-connecting-ip": "wrong" }),
    );

    // The digest of the named header's value, not of the other one.
    const expected = fakeLimits(true);
    await reservationOf(
      expected.limits,
      CONFIG,
      post({ "cf-connecting-ip": "198.51.100.4" }),
    );
    expect(named.spent).toEqual(expected.spent);
  });

  test("refuses when the trusted header did not arrive", async () => {
    // Nothing identifies the caller, so there is no bucket to reserve against.
    // The alternative is one shared bucket for everyone, which is the lockout
    // the per-address keying exists to avoid.
    //
    // And nothing to refund either: the gate hands a reservation back only on
    // the path that passed, so a refused caller cannot reach the refund at all -
    // a matter of type rather than of the handler remembering.
    const { limits, spent } = fakeLimits(true);

    const { refused, reason } = await refusalOf(limits, CONFIG, post());

    expect(refused.status).toBe(429);
    // A minute, not the second a spent budget gets: nothing refills here, so a
    // client told to retry at once retries forever against a fixed answer.
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(spent).toEqual([]);
    // Named, because this is the one an operator has to be told about and the
    // spent-budget refusal is not.
    expect(reason).toBe("no-client-address");
  });

  test("refuses a blank header rather than reserving an empty bucket", async () => {
    const { limits, spent } = fakeLimits(true);

    // Off `CONFIG` rather than the literal, because this is the one case where
    // the two must be the same header - a mismatch here would pass for the
    // wrong reason, by looking exactly like the header never arriving. Not the
    // shared `CLIENT_IP_HEADER` from tests/app-harness.ts: that names a
    // different header, and the point is the one this config asked for.
    const { refused, reason } = await refusalOf(
      limits,
      CONFIG,
      post({ [CONFIG.clientIpHeader]: "" }),
    );

    expect(refused.status).toBe(429);
    expect(spent).toEqual([]);
    expect(reason).toBe("no-client-address");
  });
});

/**
 * The operator's notice, which the route owns rather than the gate.
 *
 * Once per route instance, held in the factory's closure. It used to be keyed
 * on the config object process-wide, which made "once" depend on whether two
 * app instances happened to share a `Config` - so a second deployment in the
 * same process could be silently misconfigured.
 */
describe("the missing-header warning", () => {
  // `spent` kept rather than dropped on the floor: these cases are about a
  // request that never reaches the counter, so what makes them mean anything
  // is that the bucket stayed untouched - and `fakeLimits(true).limits` alone
  // throws that evidence away.
  const route = () => {
    const { limits, spent } = fakeLimits(true);
    return {
      run: createUnlockRoute(),
      deps: { plans: memoryPlans(), limits, config: ROUTE_CONFIG, logger },
      spent,
    };
  };

  test("says so in the log, because the symptom is otherwise silent", async () => {
    // Every redemption on this deployment answers 429 and no reader can tell
    // why. Configuration refuses to load without naming a header, so reaching
    // here means the proxy in front is not sending the one it was told to
    // trust - which is an operator's problem and needs saying once.
    const { run, deps, spent } = route();

    expect((await run(deps, post(), "abc")).status).toBe(429);

    // Refused before the counter, so no bucket was charged - which is what
    // makes this a deployment fault rather than a caller using up its budget.
    expect(spent).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("no trusted client address header");
    // Names the header it looked for, so the fix does not need a code read.
    expect(warnings[0]?.fields).toEqual({
      header: ROUTE_CONFIG.clientIpHeader,
    });
  });

  /**
   * Present and empty, which is a different branch from absent: a proxy that
   * forwards the header but has nothing to put in it. `clientAddress` tests
   * `=== ""` beside its null check for exactly this, and without a case here
   * dropping that half would leave an empty string hashed into a bucket key -
   * one shared bucket for every caller behind that proxy, which is the
   * silent-throttle failure the null path exists to avoid.
   */
  test("treats a header sent empty as a header not sent", async () => {
    const { run, deps, spent } = route();

    const request = post({ [ROUTE_CONFIG.clientIpHeader]: "" });
    expect((await run(deps, request, "abc")).status).toBe(429);

    expect(spent).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("no trusted client address header");
    expect(warnings[0]?.fields).toEqual({
      header: ROUTE_CONFIG.clientIpHeader,
    });
  });

  test("says it once, so a stranger cannot flood the log with refusals", async () => {
    // The route takes no credential, and every one of these answers 429 - so a
    // line per attempt is a log bill anyone can run up. The refusal itself is
    // still every time; only the operator's notice is deduplicated.
    const { run, deps } = route();

    for (let i = 0; i < 3; i += 1) {
      expect((await run(deps, post(), "abc")).status).toBe(429);
    }

    expect(warnings).toHaveLength(1);
  });

  test("a second route instance says it again, rather than inheriting silence", async () => {
    // The bug the closure replaced: two apps in one process shared the flag
    // whenever they shared a config object, so the second stayed quiet.
    const first = route();
    await first.run(first.deps, post(), "abc");

    const second = route();
    await second.run(second.deps, post(), "abc");

    expect(warnings).toHaveLength(2);
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
