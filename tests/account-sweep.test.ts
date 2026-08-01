import { describe, expect, test } from "bun:test";
import { sweepAccountObjects } from "../src/auth/instance.ts";
import { PLAN_PAGE_SIZE, WORKERS_MAX_PLANS_PER_USER } from "../src/limits.ts";
import type { Logger } from "../src/log.ts";
import type {
  AccountClosingRepo,
  PlanRepo,
  PlanStorage,
} from "../src/services/types.ts";
import {
  type MemoryPlans,
  memoryPlans,
  type StoredPlan,
  storedPlan,
} from "./fakes.ts";

/**
 * The irreversible half of account deletion, driven directly.
 *
 * Better Auth calls it as `onBeforeDeleteUser` and aborts the deletion when it
 * throws, so what these assertions are really about is the one invariant that
 * survives every ending: an object is never left with no row naming it. The
 * sweep may return having removed everything, or throw having removed some of
 * it and left those rows deleted too - what it must never do is return while
 * an object it did not reach still has a row, because the cascade then takes
 * that row and strands the object at `/p/{id}` forever.
 *
 * Reaching it through `betterAuth` would mean standing up an auth instance to
 * seed a refusal.
 */

const OWNER = "user-a";

/** One `logger` call, so the sweep's own account of itself can be asserted. */
interface LogLine {
  level: "warn" | "info";
  fields: Record<string, unknown>;
  message: string;
}

/** The two levels `sweepAccountObjects` uses, and nothing else. */
type SweepLogger = Pick<Logger, "warn" | "info">;

interface Fixture {
  /** Every id `storage.delete` was called with, in order, duplicates kept. */
  objects: string[];
  closing: Set<string>;
  rows: Map<string, StoredPlan>;
  /**
   * Every marker, listing, and object delete, in the order they happened. The
   * marker going first is the whole reason the sweep is safe, and only an
   * ordering can say so.
   */
  steps: string[];
  /**
   * What the sweep logged. The one report an operator gets of a deletion that
   * finished with something odd about it, so the counts in it are a contract
   * rather than decoration.
   */
  logs: LogLine[];
  /**
   * Exactly what the sweep asks for. Narrowed rather than cast to `Logger`:
   * a cast would keep compiling if the sweep started calling `error`, and the
   * fixture would answer `undefined is not a function` at run time instead of
   * failing to typecheck.
   */
  logger: SweepLogger;
  /** The unwrapped repository, for an override that delegates to it. */
  base: MemoryPlans;
  plans: PlanRepo;
  storage: PlanStorage;
  accountClosing: AccountClosingRepo;
}

function fixture(planOverrides: Partial<PlanRepo> = {}): Fixture {
  const objects: string[] = [];
  const steps: string[] = [];
  const logs: LogLine[] = [];
  const closing = new Set<string>();
  const base = memoryPlans();
  const listByUser: PlanRepo["listByUser"] = async (userId, limit) => {
    steps.push("list");
    return await base.listByUser(userId, limit);
  };
  // Pino's `LogFn` may be called with the message alone, so `message` is
  // optional here or this does not satisfy it. The sweep always passes both;
  // the fallback is what makes the signature honest rather than a cast.
  const record =
    (level: LogLine["level"]) => (fields: unknown, message?: string) => {
      logs.push({
        level,
        fields: (fields ?? {}) as Record<string, unknown>,
        message: message ?? "",
      });
    };

  return {
    objects,
    steps,
    logs,
    logger: { warn: record("warn"), info: record("info") },
    closing,
    rows: base.rows,
    base,
    plans: { ...base, listByUser, ...planOverrides },
    storage: {
      put: async () => {},
      get: async () => null,
      delete: async (id) => {
        steps.push("delete");
        objects.push(id);
      },
      probe: async () => {},
    },
    accountClosing: {
      open: async (userId) => {
        steps.push("open");
        closing.add(userId);
      },
      isOpen: async (userId) => closing.has(userId),
    },
  };
}

/** Rows straight into the map: `insert` would spend a quota none of this is about. */
function seed(f: Fixture, ids: string[]): void {
  for (const id of ids) f.rows.set(id, storedPlan({ id, userId: OWNER }));
}

function run(f: Fixture, maxAttempts?: number): Promise<void> {
  return sweepAccountObjects({
    plans: f.plans,
    accountClosing: f.accountClosing,
    storage: f.storage,
    logger: f.logger,
    userId: OWNER,
    maxAttempts,
  });
}

/** What one Cloudflare Workers invocation may make, on the paid plan. */
const WORKERS_SUBREQUEST_LIMIT = 1000;
/** Left for the row deletion Better Auth performs around the hook. */
const AUTH_RESERVE = 100;

/**
 * The arithmetic behind `WORKERS_MAX_PLANS_PER_USER`, enforced rather than
 * described.
 *
 * That constant is a subrequest figure dressed as a plan count, so it stops
 * being correct the moment either it or `PLAN_PAGE_SIZE` moves - and nothing
 * about a sweep that overruns the budget looks like a ceiling being wrong. It
 * looks like workerd ending the request. This is what fails first instead.
 */
test("the sweep ceiling fits one Workers invocation", () => {
  // A listing per page, plus the empty one that ends the loop, plus the
  // marker; then the pair of deletes each plan costs.
  const listings = Math.ceil(WORKERS_MAX_PLANS_PER_USER / PLAN_PAGE_SIZE) + 1;
  const subrequests = 2 * WORKERS_MAX_PLANS_PER_USER + listings + 1;

  expect(subrequests).toBeLessThanOrEqual(
    WORKERS_SUBREQUEST_LIMIT - AUTH_RESERVE,
  );
});

/**
 * And the same ceiling measured rather than computed.
 *
 * The arithmetic above restates the formula the constant was chosen from, so
 * the two agree by construction and would keep agreeing if the sweep itself
 * started making a call neither of them knows about. This counts what the
 * implementation actually issues for a full account.
 */
test("a full account's sweep issues no more calls than that", async () => {
  const f = fixture();
  seed(
    f,
    Array.from({ length: WORKERS_MAX_PLANS_PER_USER }, (_, i) => `p${i}`),
  );

  await run(f, WORKERS_MAX_PLANS_PER_USER);

  // `steps` records the marker, every listing, and every object delete; the
  // row deletes are the removals, one per plan.
  const subrequests = f.steps.length + WORKERS_MAX_PLANS_PER_USER;

  expect(f.rows.size).toBe(0);
  expect(subrequests).toBeLessThanOrEqual(
    WORKERS_SUBREQUEST_LIMIT - AUTH_RESERVE,
  );
});

describe("sweepAccountObjects", () => {
  /**
   * The marker first, before anything is listed. An upload that claims a row
   * after the sweep passed it and writes its object before the cascade would
   * leave that object served at `/p/{id}` with no row to own it; the marker is
   * what refuses that upload, so a sweep that read the first page before
   * setting it has a window where nothing does.
   */
  test("marks the account, then removes every object and row", async () => {
    const f = fixture();
    seed(f, ["p1", "p2", "p3"]);

    await run(f);

    expect(f.steps[0]).toBe("open");
    expect(f.steps.slice(0, 3)).toEqual(["open", "list", "delete"]);
    expect(f.objects.toSorted()).toEqual(["p1", "p2", "p3"]);
    expect(f.rows.size).toBe(0);

    // One line, at info, counting what went. No `refusedCount`: the field is
    // what distinguishes a sweep that met something odd from one that did not,
    // so reporting a zero on every clean deletion would make it say nothing.
    expect(f.logs).toEqual([
      {
        level: "info",
        fields: { userId: OWNER, planCount: 3 },
        message: "deleted plan objects before account deletion",
      },
    ]);
  });

  /**
   * The loop re-lists until nothing comes back, so a row `deleteOwned` refuses
   * while `listByUser` keeps returning it is the one shape that cannot finish.
   * It must end as an error, not as a hung request and not as a return - a
   * return hands Better Auth an all-clear, and the cascade then removes a row
   * naming an object the sweep never got.
   */
  test("throws on a row it can never remove, rather than looping", async () => {
    const f = fixture({ deleteOwned: async () => false });
    seed(f, ["stuck"]);

    await expect(run(f)).rejects.toThrow(/not making progress/);
    expect(f.rows.size).toBe(1);
  });

  /** One object delete per plan, not one per pass: a refusal is not retried. */
  test("sweeps a refused object once, however many passes it takes", async () => {
    const f = fixture({ deleteOwned: async () => false });
    seed(f, ["stuck"]);

    await expect(run(f)).rejects.toThrow();
    expect(f.objects).toEqual(["stuck"]);
  });

  /**
   * The benign refusal: the owner deleted that plan while the sweep ran, so
   * the row is gone by the next listing. Nothing is orphaned - no row is left
   * naming an object - and aborting the deletion over it would be wrong.
   *
   * It is not silent either. The account is gone irreversibly and one of its
   * plans took a path nobody watched, so the warning is the only record that
   * it happened - and the counts are what make it readable, since "some plans"
   * with no numbers says nothing about whether one row raced or half the
   * account did.
   */
  test("finishes when a refused row stops being listed, and says so", async () => {
    const f = fixture();
    f.plans.deleteOwned = async (id, userId) => {
      if (id !== "vanishing") return await f.base.deleteOwned(id, userId);
      f.rows.delete(id);
      return false;
    };
    seed(f, ["mine", "vanishing"]);

    await expect(run(f)).resolves.toBeUndefined();
    expect(f.rows.size).toBe(0);

    // Warn, not info: a deletion that finished is still a deletion, but not
    // the one that was asked for. `planCount` counts what this sweep removed
    // and `refusedCount` what went by another route - one each here.
    expect(f.logs).toEqual([
      {
        level: "warn",
        fields: { userId: OWNER, planCount: 1, refusedCount: 1 },
        message:
          "some plans were removed by another writer during the account sweep",
      },
    ]);
  });

  /**
   * A storage failure has to reach Better Auth, which aborts the deletion on
   * it. Swallowing one would leave the object behind and let the cascade take
   * the row naming it - the exact end this whole function exists to avoid, and
   * reached by the one path where being quiet looks like being tidy.
   *
   * The row stays too: the object is the thing that could not be removed, and
   * the row is the only handle left on it.
   */
  test("propagates a storage failure rather than deleting the row", async () => {
    const f = fixture();
    seed(f, ["p1"]);
    f.storage.delete = async () => {
      throw new Error("bucket unreachable");
    };

    await expect(run(f)).rejects.toThrow("bucket unreachable");
    expect(f.rows.size).toBe(1);
  });

  test("leaves another account's plans alone", async () => {
    const f = fixture();
    seed(f, ["mine"]);
    f.rows.set("theirs", storedPlan({ id: "theirs", userId: "user-b" }));

    await run(f);

    expect([...f.rows.keys()]).toEqual(["theirs"]);
    expect(f.objects).toEqual(["mine"]);
    expect(f.closing.has("user-b")).toBe(false);
  });

  describe("the per-invocation budget", () => {
    test("does not fire on an account that fits it exactly", async () => {
      const f = fixture();
      seed(f, ["p1", "p2", "p3"]);

      await expect(run(f, 3)).resolves.toBeUndefined();
      expect(f.rows.size).toBe(0);
    });

    /**
     * Past the budget the sweep stops rather than let workerd end the request
     * with "Too many subrequests". What it removed stays removed, so the retry
     * the message asks for resumes instead of starting over.
     */
    test("stops at the budget and resumes on the next attempt", async () => {
      const f = fixture();
      seed(f, ["p1", "p2", "p3", "p4", "p5"]);

      await expect(run(f, 2)).rejects.toThrow(/Retry the deletion/);
      expect(f.rows.size).toBe(3);
      expect(f.objects).toHaveLength(2);

      await expect(run(f, 2)).rejects.toThrow(/Retry the deletion/);
      expect(f.rows.size).toBe(1);

      await expect(run(f, 2)).resolves.toBeUndefined();
      expect(f.rows.size).toBe(0);
      expect(f.objects).toHaveLength(5);
    });

    /**
     * Attempts, not removals. A refused row still spent its object delete and
     * its row delete, so a budget counting only successes would let an account
     * full of refusals run past the very limit this exists to respect.
     *
     * And the ending is the stalled one, not the resumable one: a budget spent
     * without removing anything is a sweep no retry can advance, so the error
     * must not ask for one.
     */
    test("is spent by refusals, and says so as a stall not a retry", async () => {
      const f = fixture({ deleteOwned: async () => false });
      seed(f, ["p1", "p2", "p3"]);

      await expect(run(f, 2)).rejects.toThrow(/not making progress/);
      expect(f.objects).toHaveLength(2);
    });

    /**
     * The refusal that must not read as a stall: these rows were removed by
     * their owner while the sweep ran, so they are not listed again and the
     * only thing left is work a retry will finish.
     */
    test("asks for a retry when the refusals were concurrent deletes", async () => {
      const f = fixture();
      f.plans.deleteOwned = async (id, userId) => {
        if (id !== "vanishing") return await f.base.deleteOwned(id, userId);
        f.rows.delete(id);
        return false;
      };
      seed(f, ["vanishing", "p1", "p2"]);

      await expect(run(f, 2)).rejects.toThrow(/Retry the deletion/);
      expect(f.rows.size).toBe(1);
    });

    test("is absent by default, which is what self-hosting gets", async () => {
      const f = fixture();
      seed(
        f,
        Array.from({ length: 50 }, (_, i) => `p${i}`),
      );

      await expect(run(f)).resolves.toBeUndefined();
      expect(f.rows.size).toBe(0);
    });
  });
});
