import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { pino } from "pino";
import { z } from "zod";
import { ref } from "../src/api/schemas.ts";
import type { Dialect } from "../src/db/dialect.ts";
import { retryAfterSeconds, sometimes } from "../src/db/rate-limit-window.ts";
import { createUnlockRateLimitRepo } from "../src/db/rate-limits.shared.ts";
import { accountClosing } from "../src/db/schema/account-closing.sqlite.ts";
import { user } from "../src/db/schema/auth.sqlite.ts";
import { plan, planGrant } from "../src/db/schema/plan.sqlite.ts";
import {
  unlockRateLimit,
  uploadRateLimit,
} from "../src/db/schema/rate-limit.sqlite.ts";
import { healthz, PROBE_TIMEOUT_MS, type Probed } from "../src/http/healthz.ts";
import { replacePlan } from "../src/http/replace-plan.ts";
import type {
  PlanObject,
  PlanRepo,
  PlanStorage,
} from "../src/services/types.ts";
import {
  buildApp,
  CONFIG,
  html,
  memoryStorage,
  openAccounts,
  openRateLimits,
  PUBLIC_BASE_URL,
  upload,
} from "./app-harness.ts";
import {
  at,
  fakeAuth,
  OWNER,
  PLAN_ID,
  recordingLogger,
  silentLogger,
} from "./fakes.ts";
import { basePlanRepoStub } from "./plan-repo-stub.ts";

/**
 * The failure paths that only appear when something underneath misbehaves:
 * an id that collides, an account being deleted mid-upload, a probe that never
 * answers, a cleanup that itself fails. None of them are reachable from the
 * e2e stack, because every one requires a backend that is broken in a specific
 * way.
 */

describe("the dashboard route", () => {
  test("renders the dashboard document", async () => {
    const app = buildApp();

    const response = await app.fetch("/dashboard");

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"dashboard"');
    // The origin comes from configuration, not from the request's `Host`.
    expect(body).toContain(PUBLIC_BASE_URL);
  });

  test("is rendered signed-out, which is what the client hydrates onto", async () => {
    const response = await buildApp().fetch("/dashboard");

    expect(await response.text()).not.toContain("nav-handle");
  });
});

describe("claiming a plan id", () => {
  /**
   * A repo whose `insert` answers with a scripted sequence, and which then
   * behaves like a real one for whatever it actually created - otherwise the
   * confirmation read after the object write would withdraw the plan and the
   * test would be measuring that instead.
   */
  const scripted = (answers: Array<"created" | "duplicate" | "quota">) => {
    const seen: string[] = [];
    const owned = new Set<string>();
    let at = 0;
    const plans: PlanRepo = {
      ...basePlanRepoStub,
      insert: async (row) => {
        seen.push(row.id);
        const answer = answers[at] ?? "duplicate";
        at += 1;
        if (answer === "created") owned.add(row.id);
        return answer;
      },
      listByUser: async () => [],
      findOwner: async (id) => (owned.has(id) ? OWNER : null),
      relabel: async () => false,
      resize: async () => false,
      deleteOwned: async (id) => owned.delete(id),
    };
    return { plans, seen };
  };

  test("a collision is retried with a fresh id", async () => {
    const { plans, seen } = scripted(["duplicate", "duplicate", "created"]);
    const app = buildApp({ sessionUser: OWNER, plans });

    const response = await app.fetch("/api/plans", upload(html()));

    expect(response.status).toBe(201);
    expect(seen.length).toBe(3);
    // Each attempt is a fresh id, not the same one retried.
    expect(new Set(seen).size).toBe(3);
  });

  test("a full account is refused rather than retried into", async () => {
    const { plans, seen } = scripted(["quota"]);
    const app = buildApp({ sessionUser: OWNER, plans });

    const response = await app.fetch("/api/plans", upload(html()));

    expect(response.status).toBe(409);
    // The ceiling is part of the same statement, so retrying could only ever
    // burn attempts against a decision that will not change.
    expect(seen.length).toBe(1);
  });

  test("exhausting every attempt gives up rather than looping", async () => {
    const { plans, seen } = scripted([]);
    const app = buildApp({ sessionUser: OWNER, plans });

    const response = await app.fetch("/api/plans", upload(html()));

    expect(response.status).toBe(500);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.length).toBeLessThan(20);
  });
});

describe("uploading to an account being deleted", () => {
  test("is refused before anything is stored", async () => {
    let writes = 0;
    const storage = memoryStorage();
    const app = buildApp({
      sessionUser: OWNER,
      accountClosing: {
        open: async () => "attempt",
        close: async () => {},
        isOpen: async () => true,
      },
      storage: {
        ...storage,
        put: async (id, body) => {
          writes += 1;
          await storage.put(id, body);
        },
      },
    });

    const response = await app.fetch("/api/plans", upload(html()));

    // Without the marker an upload can land between the object sweep and the
    // row cascade, leaving an object that outlives the row that owned it.
    expect(response.status).toBe(409);
    expect(await response.json<unknown>()).toMatchObject({
      error: "account is being deleted",
    });
    expect(writes).toBe(0);
  });
});

describe("replacing a plan whose row vanishes underneath", () => {
  const bytes = new TextEncoder().encode(html());

  /** Everything replace touches, with the row gone by the time it resizes. */
  function racing(deleteFails: boolean) {
    const logged: Array<Record<string, unknown>> = [];
    const objects = new Map<string, Uint8Array>();
    const storage: PlanStorage = {
      put: async (id, body) => {
        objects.set(id, body);
      },
      get: async (): Promise<PlanObject | null> => null,
      delete: async (id) => {
        if (deleteFails) throw new Error("storage is unreachable");
        objects.delete(id);
      },
      probe: async () => {},
    };
    const plans: PlanRepo = {
      ...basePlanRepoStub,
      insert: async () => "created",
      listByUser: async () => [],
      findOwner: async () => OWNER,
      relabel: async () => false,
      // The concurrent delete: the row is gone by the time this runs.
      resize: async () => false,
      deleteOwned: async () => false,
    };
    const sink = pino(
      // `trace`, so the capture never depends on the level production picks:
      // a warn demoted from error would empty these assertions silently.
      { level: "trace" },
      {
        write: (line: string) => {
          logged.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    );
    return { storage, plans, objects, logged, sink };
  }

  /**
   * Everything `replacePlan` needs except the logger, which is the one thing
   * these two cases differ on. The session resolves to the owner because the
   * handler authenticates itself now - the router used to - and the upload
   * allowance is open because its refusal has a suite of its own.
   */
  const replaceDeps = (storage: PlanStorage, plans: PlanRepo) => ({
    auth: fakeAuth({ sessionUser: OWNER }).auth,
    config: CONFIG,
    plans,
    uploadRateLimits: openRateLimits,
    accountClosing: openAccounts,
    storage,
  });

  const request = () =>
    new Request(`${PUBLIC_BASE_URL}/api/plans/${PLAN_ID}`, {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: bytes,
    });

  test("takes its own object back out and 404s", async () => {
    const { storage, plans, objects } = racing(false);

    const response = await replacePlan(
      { ...replaceDeps(storage, plans), logger: silentLogger },
      request(),
      PLAN_ID,
    );

    expect(response.status).toBe(404);
    // Nothing else can be holding it: ids are never reissued.
    expect(objects.has(PLAN_ID)).toBe(false);
  });

  test("a cleanup that itself fails is logged, not thrown", async () => {
    const { storage, plans, logged, sink, objects } = racing(true);

    const response = await replacePlan(
      { ...replaceDeps(storage, plans), logger: sink },
      request(),
      PLAN_ID,
    );

    // The caller still gets the honest answer; the orphan is the operator's
    // problem and has to be findable.
    expect(response.status).toBe(404);
    // Located by message rather than by position: the log is not ordered by
    // this test, and `logged[0]` would silently start checking another line.
    const orphan = logged.find(
      (line) =>
        line["msg"] ===
        "failed to delete an orphaned plan object; its bytes are still stored",
    );
    // Named separately so a missing line reads as "no such log entry" rather
    // than as a shape mismatch against `undefined`.
    expect(orphan).toBeDefined();
    expect(orphan).toMatchObject({ planId: PLAN_ID });
    // And it really is orphaned: the log would say so either way, but what
    // makes it the operator's problem is the object still sitting in the
    // bucket with no row naming it.
    expect([...objects.keys()]).toContain(PLAN_ID);
  });
});

describe("the health probe", () => {
  /**
   * Taken from the contract rather than restated: a probe that grew a second
   * argument would then be a type error here instead of an untested signature.
   */
  type Probe = PlanStorage["probe"];

  /**
   * A backend that answers the probe and nothing else.
   *
   * `healthz` only ever calls `probe()`, so a stand-in carrying the rest of
   * `PlanStorage`, `KvStore`, or `Db` would be several dozen methods of noise
   * around the one line under test. The widening is done once, here.
   */
  const backend = <T>(probe: Probe): T => ({ probe }) as T;

  const noop: Probe = async () => {};

  const probed = (over: Partial<Probed> = {}) => {
    const lines: Array<Record<string, unknown>> = [];
    const sink = pino(
      // Captured at `trace` for the reason above.
      { level: "trace" },
      {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    );
    const services: Probed = {
      storage: backend(noop),
      db: backend(noop),
      kv: backend(noop),
      logger: sink,
      ...over,
    };
    return { services, lines };
  };

  const down =
    (message: string): Probe =>
    async () => {
      throw new Error(message);
    };

  test("reports 503 when one backend is down, and names only which", async () => {
    const { services } = probed({ kv: backend(down("cache refused")) });

    const response = await healthz("node", async () => services);

    expect(response.status).toBe(503);
    expect(await response.json<unknown>()).toEqual({
      status: "error",
      checks: { storage: "ok", db: "ok", kv: "error" },
    });
  });

  test("the reason goes to the log and never into the body", async () => {
    const secret = "postgres://user:hunter2@db.internal/plans refused";
    const { services, lines } = probed({ db: backend(down(secret)) });

    const body = await (await healthz("node", async () => services)).text();

    // `/healthz` is unauthenticated and a driver error can embed the
    // connection string, so nothing from it may reach the response.
    expect(body).not.toContain("hunter2");

    /*
     * The log has to identify the failure well enough to act on. Not asserted:
     * that the credential itself appears there. Requiring it would pin the
     * opposite of what src/log.ts's redacting destination is for, and would
     * turn adding redaction into a test failure.
     */
    const failure = lines.find((line) => line["check"] === "db");
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({ check: "db", msg: "probe failed" });
    // And it carries the error, whatever a destination later does with it.
    expect(failure?.["err"]).toBeDefined();
  });

  test("every failing backend is reported, not just the first", async () => {
    const fail = down("down");
    const { services } = probed({
      storage: backend(fail),
      db: backend(fail),
      kv: backend(fail),
    });

    expect(
      await (await healthz("node", async () => services)).json<unknown>(),
    ).toEqual({
      status: "error",
      checks: { storage: "error", db: "error", kv: "error" },
    });
  });

  test("a second call inside the window is answered from the cache", async () => {
    let probes = 0;
    const { services } = probed({
      db: backend(async () => {
        probes += 1;
      }),
    });

    const first = await healthz("node", async () => services);
    const second = await healthz("node", async () => services);

    // Docker polls every 30s; caching turns a flood of anonymous calls into
    // one round of backend work.
    expect(probes).toBe(1);
    expect(second.status).toBe(first.status);
    // Stored as a factory, because a Response body can only be read once.
    expect(await second.json<unknown>()).toEqual(await first.json<unknown>());
  });

  test("a different wiring gets its own cache entry", async () => {
    let probes = 0;
    const count: Probe = async () => {
      probes += 1;
    };
    const one = probed({ db: backend(count) });
    const two = probed({ db: backend(count) });

    await healthz("node", async () => one.services);
    await healthz("node", async () => two.services);

    // Keyed on the services object rather than a module variable, so a test
    // that builds its own fakes never inherits the previous one's answer.
    expect(probes).toBe(2);
  });

  test("the probe deadline is short enough to be worth having", () => {
    /*
     * Pinned rather than measured. The test below proves a deadline exists -
     * without one it never returns and times out - but says nothing about its
     * length, and a deadline of nine seconds would satisfy it while holding
     * the sockets this exists to release. Wall-clock bounds said that once and
     * were load-sensitive; this says it deterministically.
     */
    expect(PROBE_TIMEOUT_MS).toBe(2_000);
  });

  /*
   * Every probed backend, not just the first. `healthz` wires the signal into
   * each of the three separately, so one of them losing it would leave that
   * driver holding its socket while the other two released theirs - and a test
   * that only watched `storage` would stay green through it.
   */
  test.each(["storage", "db", "kv"] as const)(
    "a %s probe that never answers is cancelled, and the route still answers",
    async (check) => {
      let seen: AbortSignal | undefined;
      const { services } = probed({
        // Typed by the key rather than left to infer: a computed key gives
        // `backend` no contextual type, so `T` lands on `unknown` and the
        // stub would satisfy `Partial<Probed>` whatever shape it had.
        [check]: backend<Probed[typeof check]>((signal?: AbortSignal) => {
          seen = signal;
          return new Promise<void>(() => {});
        }),
      });

      const response = await healthz("node", async () => services);

      // With no deadline this call never returns and the test times out. There
      // is no authorization step to check first: `/healthz` is deliberately
      // unauthenticated (src/http/healthz.ts), so the probe result is the only
      // thing this route produces.
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        checks: { [check]: "error" },
      });

      // The half a bare `Promise.race` leaves out. Answering the request is not
      // the same as releasing the socket behind it, and the signal is the only
      // thing that reaches the driver: without this the S3 client holds its
      // connection and a pool client for as long as the endpoint stays silent.
      //
      // The reason as well as the flag. Cancellation happens in one place - the
      // timeout callback, which rejects and then calls `controller.abort(expired)`
      // with the same error; `withTimeout`'s `finally` only clears the timer. So
      // the message is what identifies the deadline as what cancelled this,
      // rather than some later abort, and it pins the wording an operator reads.
      expect(seen?.aborted).toBe(true);
      expect((seen?.reason as Error | undefined)?.message).toBe(
        `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
      );
    },
    10_000,
  );

  test("a driver that fails on abort still reports the deadline", async () => {
    /*
     * The reason the reject comes before the abort. `abort` runs a listener
     * synchronously, so a driver that turns cancellation into its own rejection
     * settles the race first if the order is reversed - and `/healthz` then
     * blames the driver's error for a failure the deadline caused, which is the
     * one thing an operator reads this line to find out.
     */
    const { services, lines } = probed({
      storage: backend((signal?: AbortSignal) => {
        return new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("connection reset by peer"));
          });
        });
      }),
    });

    const stray: unknown[] = [];
    // Only the rejection this test provokes. The listener is process-wide, so
    // anything else running in the same isolate would otherwise land in the
    // assertion below and fail a claim it has nothing to do with.
    const watch = (reason: unknown) => {
      if (String(reason).includes("connection reset by peer")) {
        stray.push(reason);
      }
    };
    process.on("unhandledRejection", watch);
    // Declared before the `try` rather than assigned in one `const`: the
    // listener is a process-wide global, so every path out of here - including
    // a `healthz` that rejects - has to reach the `finally` that removes it.
    let response: Response;
    try {
      response = await healthz("node", async () => services);
      // The driver rejects after the race has already settled, so nothing is
      // waiting on it any more. `Promise.race` keeps a handler on both sides,
      // which is what stops that from surfacing as an unhandled rejection -
      // and on a Worker an unhandled rejection takes the isolate with it.
      // Two turns, not one: the rejection has to travel the driver's own
      // `catch` before the runtime could report it, and a single turn can
      // close the window before it would have arrived - passing whether or
      // not the handler that suppresses it is there.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", watch);
    }

    expect(stray).toEqual([]);
    expect(response.status).toBe(503);
    const failure = lines.find((line) => line["check"] === "storage");
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure?.["err"])).toContain(
      `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
    );
    expect(JSON.stringify(failure?.["err"])).not.toContain(
      "connection reset by peer",
    );
  }, 10_000);
});

describe("the fixed-window arithmetic both limiters share", () => {
  test("reports the seconds left in the current window", () => {
    // 40s into a 60s window.
    expect(retryAfterSeconds(1_000_000, 1_040_000, 60_000)).toBe(20);
  });

  test("rounds a part-second up, so a caller never retries too early", () => {
    expect(retryAfterSeconds(0, 500, 60_000)).toBe(60);
    expect(retryAfterSeconds(0, 59_001, 60_000)).toBe(1);
  });

  test("never reports zero or a negative wait", () => {
    // A window that has already closed still asks for one second: a caller
    // told to wait zero would spin.
    expect(retryAfterSeconds(0, 60_000, 60_000)).toBe(1);
    expect(retryAfterSeconds(0, 120_000, 60_000)).toBe(1);
  });

  test("the sweep fires on a minority of calls", () => {
    // Wrapped, so `Array.from` cannot pass its index in as an argument if
    // `sometimes` ever grows a parameter.
    const fired = Array.from({ length: 4000 }, () => sometimes()).filter(
      Boolean,
    ).length;

    // One in sixteen. Sweeping every call would double the writes on exactly
    // the path the per-address cap cannot bound.
    expect(fired).toBeGreaterThan(4000 / 16 / 3);
    expect(fired).toBeLessThan((4000 / 16) * 3);
  });
});

describe("the unlock bucket's opportunistic prune", () => {
  /**
   * `sometimes` fires on one call in sixteen, so a prune that throws would
   * refuse that fraction of redemptions - on the one route with no credential
   * to retry with. The prune is housekeeping and the count is the decision;
   * only the second may fail the request.
   */

  /** A window far enough back that the wait is the floored one second. */
  const WINDOW_START = 1_700_000_000_000;

  /**
   * The prune and nothing else. One predicate, used both to decide what the
   * stub refuses and to assert what it was asked - two copies of the same
   * `startsWith` would let the test refuse one statement and count another.
   */
  const isPrune = (statement: string) =>
    statement.trimStart().toLowerCase().startsWith("delete");

  /** Every statement `run` was asked to execute, so the prune is identifiable. */
  interface Dispatched {
    statements: string[];
  }

  /**
   * The counter's allowed answer, whatever it is asked: `consumeOne` reads one
   * row back from its upsert, so a stub that always returns one is a bucket
   * that always has room. It is the prune above it that is under test.
   *
   * `run` records what it was given and refuses only what `onDelete` picks
   * out, so a test can fail the prune without failing anything else - and can
   * then assert the prune was attempted at all, which a `run` that threw
   * unconditionally could never distinguish from one that never ran.
   */
  const dialect = (
    dispatched: Dispatched,
    onDelete: () => Promise<void> = async () => {},
  ): Dialect => {
    const render = new PgDialect();
    const run = async (query: SQL) => {
      const text = render.sqlToQuery(query).sql;
      dispatched.statements.push(text);
      if (isPrune(text)) await onDelete();
    };
    return {
      rows: async <T extends Record<string, unknown>>() =>
        [{ windowStart: WINDOW_START }] as unknown as T[],
      run,
      tables: {
        plan,
        planGrant,
        user,
        accountClosing,
        uploadRateLimit,
        unlockRateLimit,
      },
      claim: async (_userId, body) => await body({ rows: async () => [], run }),
      createdAt: (value) => new Date(Number(value)),
      floor: (expr) => sql`max(${expr}, 0)`,
    };
  };

  /** The prune, as `run` sees it: the only `delete` the repo issues. */
  const pruned = (dispatched: Dispatched) =>
    dispatched.statements.filter(isPrune);

  test("a prune that fails is logged, and the redemption still passes", async () => {
    const { logger, lines } = recordingLogger();
    const failure = new Error("database is locked");
    const dispatched: Dispatched = { statements: [] };
    const repo = createUnlockRateLimitRepo(
      dialect(dispatched, async () => {
        throw failure;
      }),
      logger,
      { shouldSweep: () => true },
    );

    expect(await repo.consume("addr", 3, 60)).toEqual({
      allowed: true,
      retryAfter: 1,
      windowStart: WINDOW_START,
    });
    // Attempted, and it was the prune that failed rather than the sweep being
    // skipped - which every other assertion here would read the same way.
    expect(pruned(dispatched)).toHaveLength(1);
    // The cause travels, not just the fact. A line saying only that a sweep
    // failed leaves an operator with a table that stops shrinking and nothing
    // naming why - and this is the one place the reason is still in hand.
    const warnings = at(lines, "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("unlock rate-limit sweep failed");
    expect(warnings[0]?.fields["err"]).toBe(failure);
  });

  test("and a prune that succeeds says nothing", async () => {
    // Captured, like its sibling above, rather than thrown from. A `warn` that
    // throws would be caught by the very `try` under test and reported as a
    // failed prune, so the test would pass whether the sweep warned or not.
    const { logger, lines } = recordingLogger();
    const dispatched: Dispatched = { statements: [] };
    const repo = createUnlockRateLimitRepo(dialect(dispatched), logger, {
      shouldSweep: () => true,
    });

    expect((await repo.consume("addr", 3, 60)).allowed).toBe(true);
    expect(pruned(dispatched)).toHaveLength(1);
    expect(at(lines, "warn")).toEqual([]);
  });
});

describe("the OpenAPI component registry", () => {
  test("refuses a reference to a schema nothing registered", () => {
    // A dangling `$ref` renders as a broken document rather than failing, so
    // this fails at boot instead.
    expect(() => ref(z.object({ nope: z.string() }))).toThrow(
      "schema is not a registered component",
    );
  });
});
