import { describe, expect, test } from "bun:test";
import { pino } from "pino";
import { z } from "zod";
import { ref } from "../src/api/schemas.ts";
import { retryAfterSeconds, sometimes } from "../src/db/rate-limit-window.ts";
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
  OWNER,
  PLAN_ID,
  PUBLIC_BASE_URL,
  upload,
} from "./app-harness.ts";
import { basePlanRepoStub } from "./plan-repo-stub.ts";

/**
 * The failure paths that only appear when something underneath misbehaves:
 * an id that collides, an account being deleted mid-upload, a probe that never
 * answers, a cleanup that itself fails. None of them are reachable from the
 * e2e stack, because every one requires a backend that is broken in a specific
 * way.
 */

const logger = pino({ level: "silent" });

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
      accountClosing: { open: async () => {}, isOpen: async () => true },
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

  const request = () =>
    new Request(`${PUBLIC_BASE_URL}/api/plans/${PLAN_ID}`, {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: bytes,
    });

  test("takes its own object back out and 404s", async () => {
    const { storage, plans, objects } = racing(false);

    const response = await replacePlan(
      storage,
      plans,
      logger,
      request(),
      PLAN_ID,
      OWNER,
      CONFIG,
    );

    expect(response.status).toBe(404);
    // Nothing else can be holding it: ids are never reissued.
    expect(objects.has(PLAN_ID)).toBe(false);
  });

  test("a cleanup that itself fails is logged, not thrown", async () => {
    const { storage, plans, logged, sink } = racing(true);

    const response = await replacePlan(
      storage,
      plans,
      sink,
      request(),
      PLAN_ID,
      OWNER,
      CONFIG,
    );

    // The caller still gets the honest answer; the orphan is the operator's
    // problem and has to be findable.
    expect(response.status).toBe(404);
    // Located by message rather than by position: the log is not ordered by
    // this test, and `logged[0]` would silently start checking another line.
    const orphan = logged.find(
      (line) => line["msg"] === "orphaned plan object",
    );
    // Named separately so a missing line reads as "no such log entry" rather
    // than as a shape mismatch against `undefined`.
    expect(orphan).toBeDefined();
    expect(orphan).toMatchObject({ planId: PLAN_ID });
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
        [check]: backend((signal?: AbortSignal) => {
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
      // timeout callback, which calls `controller.abort(expired)` before it
      // rejects; `withTimeout`'s `finally` only clears the timer. So the message
      // is what identifies the deadline as what cancelled this, rather than some
      // later abort, and it pins the wording an operator reads in the log.
      expect(seen?.aborted).toBe(true);
      expect((seen?.reason as Error | undefined)?.message).toBe(
        `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
      );
    },
    10_000,
  );
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

describe("the OpenAPI component registry", () => {
  test("refuses a reference to a schema nothing registered", () => {
    // A dangling `$ref` renders as a broken document rather than failing, so
    // this fails at boot instead.
    expect(() => ref(z.object({ nope: z.string() }))).toThrow(
      "schema is not a registered component",
    );
  });
});
