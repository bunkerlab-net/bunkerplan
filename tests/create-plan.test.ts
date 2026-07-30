import { describe, expect, test } from "bun:test";
import { pino } from "pino";
import type { AppAuth } from "../src/auth/instance.ts";
import type { Config } from "../src/config.ts";
import { type CreatePlanDeps, createPlan } from "../src/http/create-plan.ts";
import type { PlanRepo, PlanStorage } from "../src/services/types.ts";
import { basePlanRepoStub } from "./plan-repo-stub.ts";

/**
 * The upload path's grant step, which runs after the row and the object are
 * already durable.
 *
 * Everything else about uploading is covered end to end; this suite exists for
 * the one thing e2e cannot reach, which is a repository that throws. A grant
 * failure must not turn a stored plan into a 500 - the caller could not then
 * tell whether to retry, and retrying would store the document twice.
 */

const OWNER = "user-a";
const KEY = "bkp_test";

const CONFIG = {
  publicBaseUrl: "https://plans.example.test",
  maxUploadBytes: 2 * 1024 * 1024,
  planIdLength: 16,
  shareCodeLength: 16,
  maxPlansPerUser: 10,
  uploadRateMax: 100,
  uploadRateWindowSec: 60,
} as unknown as Config;

/** Silent: these tests assert on responses, not on output. */
const logger = pino({ level: "silent" });

function fakeAuth(): AppAuth {
  return {
    api: {
      verifyApiKey: async () => ({ valid: true, key: { referenceId: OWNER } }),
      getSession: async () => null,
    },
  } as unknown as AppAuth;
}

function deps(over: Partial<PlanRepo> = {}): {
  deps: CreatePlanDeps;
  stored: string[];
} {
  const stored: string[] = [];
  const plans: PlanRepo = {
    ...basePlanRepoStub,
    insert: async () => "created",
    listByUser: async () => [],
    findOwner: async () => OWNER,
    relabel: async () => false,
    resize: async () => false,
    deleteOwned: async () => false,
    ...over,
  };
  const storage: PlanStorage = {
    put: async (key) => {
      stored.push(key);
    },
    get: async () => null,
    delete: async () => {},
    probe: async () => {},
  };
  return {
    deps: {
      auth: fakeAuth(),
      config: CONFIG,
      plans,
      accountClosing: { open: async () => {}, isOpen: async () => false },
      uploadRateLimits: {
        consume: async () => ({
          allowed: true,
          retryAfter: 60,
          windowStart: 0,
        }),
        refund: async () => {},
      },
      storage,
      logger,
    },
    stored,
  };
}

const upload = (query: string): Request =>
  new Request(`https://plans.example.test/api/plans?${query}`, {
    method: "PUT",
    headers: { "x-api-key": KEY, "content-type": "text/html" },
    body: "<!doctype html><title>t</title><p>hi</p>",
  });

describe("createPlan with ?grants=", () => {
  test("a grant that throws still stores the plan and says which failed", async () => {
    const { deps: d, stored } = deps({
      grantByHandle: async (_planId, _ownerId, account) => {
        if (account === "second") throw new Error("database unreachable");
        return "granted";
      },
    });

    const response = await createPlan(d, upload("grants=first,second"));

    // The plan is real, so this must not be a 5xx.
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["granted"]).toEqual(["first"]);
    expect(body["unknown"]).toEqual([]);
    expect(body["failed"]).toEqual(["second"]);
    // And the document was actually written.
    expect(stored).toHaveLength(1);
    expect(body["id"]).toBe(stored[0]);
  });

  test("an ownership read that throws leaves every account failed", async () => {
    // `storeAndConfirm` reads the owner too, to check the row survived the
    // upload, so only the second read - the one `applyGrants` does - fails.
    // That is also the honest shape: the plan was fine when it was stored.
    let reads = 0;
    const { deps: d, stored } = deps({
      findOwner: async () => {
        reads += 1;
        if (reads > 1) throw new Error("database unreachable");
        return OWNER;
      },
    });

    const response = await createPlan(d, upload("grants=first,second"));

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["granted"]).toEqual([]);
    expect(body["unknown"]).toEqual([]);
    expect(body["failed"]).toEqual(["first", "second"]);
    expect(stored).toHaveLength(1);
  });

  /**
   * A concurrent delete between storing and granting. `storeAndConfirm`
   * answers 404 when it catches the same thing a moment earlier, so this
   * window gets the same answer rather than a 201 whose `Location` names a
   * plan that has gone.
   */
  test("a plan that vanishes before its grants is the same 404", async () => {
    let reads = 0;
    const { deps: d } = deps({
      findOwner: async () => {
        reads += 1;
        return reads > 1 ? null : OWNER;
      },
    });

    const response = await createPlan(d, upload("grants=first"));

    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      error: "not found",
    });
  });

  test("naming nobody carries no grant fields at all", async () => {
    const { deps: d } = deps();
    const response = await createPlan(d, upload("visibility=private"));

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("granted");
    expect(body).not.toHaveProperty("failed");
  });
});

describe("createPlan when the upload budget is spent", () => {
  test("refuses before the body is read, not after", async () => {
    const { deps: d, stored } = deps();
    // No `windowStart`: `RateLimitResult` is a union, and the refused arm is
    // `{ allowed: false; retryAfter }`. There is no window to refund a count
    // to when no count was taken, so the field does not exist on this side -
    // adding one would not typecheck.
    d.uploadRateLimits = {
      consume: async () => ({ allowed: false, retryAfter: 30 }),
      refund: async () => {},
    };

    /*
     * `bodyUsed` rather than a spy on `getReader`. It is set by every standard
     * way of consuming a request - `arrayBuffer`, `text`, `json`, a reader -
     * so it still catches this if `readBoundedBody` is ever rewritten to reach
     * the body some other way.
     *
     * Reading first would let a caller who is already over the limit spend the
     * server's bandwidth on every refused attempt, which is most of what the
     * limit is for.
     */
    const request = upload("");

    const response = await createPlan(d, request);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(stored).toEqual([]);
    expect(request.bodyUsed).toBe(false);
  });
});
