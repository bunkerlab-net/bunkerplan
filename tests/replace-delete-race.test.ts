import { describe, expect, test } from "bun:test";
import { sweepAccountObjects } from "../src/auth/instance.ts";
import { deletePlan } from "../src/http/delete-plan.ts";
import { replacePlan } from "../src/http/replace-plan.ts";
import type { PlanStorage } from "../src/services/types.ts";
import { openAccounts, openRateLimits } from "./app-harness.ts";
import {
  deferred,
  fakeAuth,
  memoryPlans,
  silentLogger,
  storedPlan,
} from "./fakes.ts";

const OWNER = "user-a";
const ID = "plan-1";

const CONFIG = {
  maxUploadBytes: 2 * 1024 * 1024,
  publicBaseUrl: "https://plans.example.test",
  uploadRateMax: 100,
  uploadRateWindowSec: 60,
};

const HTML = "<!doctype html><html><body><p>replacement</p></body></html>";

/**
 * Both stores, in memory.
 *
 * `holdFirstDelete` pauses the first object delete so two requests can be
 * interleaved by hand rather than by luck. Off by default, because the other
 * suite here pauses somewhere else entirely: armed unconditionally, that test
 * had to reach in and release a hold it never wanted, and a reader could not
 * tell whether doing so was setup or part of the race being tested.
 */
function stores({ holdFirstDelete = false } = {}) {
  const objects = new Map<string, number>();
  objects.set(ID, 10);

  const entered = deferred();
  const released = deferred();
  let paused = false;
  /*
   * Every write and delete in order. The end state says an object is gone; it
   * does not say who removed it, and "the replacement cleaned up after itself"
   * and "a later sweep happened to catch it" leave the same empty map.
   */
  const log: string[] = [];

  const storage: PlanStorage = {
    put: async (key, body) => {
      log.push(`put ${key}`);
      objects.set(key, body.byteLength);
    },
    get: async () => null,
    delete: async (key) => {
      log.push(`delete ${key}`);
      objects.delete(key);
      if (holdFirstDelete && !paused) {
        paused = true;
        entered.resolve();
        await released.promise;
      }
    },
    probe: async () => {},
  };

  const plans = memoryPlans([storedPlan({ id: ID, userId: OWNER, size: 10 })]);

  return {
    objects,
    log,
    rows: plans.rows,
    storage,
    plans,
    auth: fakeAuth({ sessionUser: OWNER }).auth,
    hold: { entered, released },
  };
}

function put(): Request {
  return new Request(`https://example.test/api/plans/${ID}`, {
    method: "PUT",
    headers: { "content-type": "text/html" },
    body: HTML,
  });
}

describe("a replacement racing a delete", () => {
  test("leaves no object behind when the replacement lands mid-delete", async () => {
    const { objects, rows, storage, plans, auth, hold } = stores({
      holdFirstDelete: true,
    });

    // The worst interleaving there is: the delete has already removed the
    // object, so the replacement's ownership check and its own row update both
    // pass against a row that is about to disappear.
    const deleting = deletePlan(
      { auth, storage, plans, logger: silentLogger },
      new Request(`https://example.test/api/plans/${ID}`, { method: "DELETE" }),
      ID,
    );
    await hold.entered.promise;

    const replaced = await replacePlan(
      {
        auth,
        config: CONFIG,
        plans,
        uploadRateLimits: openRateLimits,
        accountClosing: openAccounts,
        storage,
        logger: silentLogger,
      },
      put(),
      ID,
    );
    expect(replaced.status).toBe(200);
    expect(objects.get(ID)).toBe(HTML.length);

    hold.released.resolve();
    expect((await deleting).status).toBe(204);

    // Neither store may keep the plan. An object with no row is served by
    // `/p/{id}` forever, with no owner and no way to remove it.
    expect(rows.size).toBe(0);
    expect(objects.size).toBe(0);
  });
});

describe("a replacement racing an account deletion", () => {
  /**
   * The same interleaving one layer up, and the one `resize` cannot catch.
   *
   * The account sweep removes an object and then the row naming it. A
   * replacement that lands between the two writes its object back and finds
   * the row still present, so `resize` says yes - and then the sweep takes
   * that row, leaving the object at `/p/{id}` with no owner and nothing able
   * to delete it. The closing marker is the only thing that sees this, which
   * is why `replacePlan` reads it after its own write.
   */
  test("leaves no object behind when it lands between object and row", async () => {
    // No hold from `stores()`: this test does its own pausing, inside
    // `deleteOwned` below.
    const { objects, log, rows, storage, plans, auth } = stores();
    const closing = new Set<string>();
    const accountClosing = {
      open: async (userId: string) => {
        closing.add(userId);
      },
      isOpen: async (userId: string) => closing.has(userId),
    };

    // Held inside `deleteOwned`, so the sweep is paused with the object gone
    // and the row still there - exactly the window.
    const atRowDelete = deferred();
    const release = deferred();
    const gated = {
      ...plans,
      deleteOwned: async (id: string, userId: string) => {
        atRowDelete.resolve();
        await release.promise;
        return await plans.deleteOwned(id, userId);
      },
    };

    const sweeping = sweepAccountObjects({
      plans: gated,
      accountClosing,
      storage,
      logger: silentLogger,
      userId: OWNER,
    });
    await atRowDelete.promise;

    const replaced = await replacePlan(
      {
        auth,
        config: CONFIG,
        plans,
        uploadRateLimits: openRateLimits,
        accountClosing,
        storage,
        logger: silentLogger,
      },
      put(),
      ID,
    );

    release.resolve();
    await sweeping;

    // 404, because the plan this replaced is being deleted.
    expect(replaced.status).toBe(404);
    expect(rows.size).toBe(0);
    expect(objects.size).toBe(0);

    /*
     * And it was the replacement that cleaned up after itself, not luck. The
     * sweep deleted the object before this test released it, the replacement
     * put its own bytes back into that gap, and the delete after the `put` is
     * `replacePlan` withdrawing them on the marker. An empty map alone would
     * read identically if the object had simply never been rewritten.
     */
    expect(log).toEqual([`delete ${ID}`, `put ${ID}`, `delete ${ID}`]);
  });
});
