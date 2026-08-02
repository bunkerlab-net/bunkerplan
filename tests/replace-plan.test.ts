import { describe, expect, test } from "bun:test";
import { type ReplacePlanDeps, replacePlan } from "../src/http/replace-plan.ts";
import type { PlanStorage } from "../src/services/types.ts";
import { openAccounts, openRateLimits } from "./app-harness.ts";
import {
  fakeAuth,
  type MemoryPlans,
  memoryPlans,
  silentLogger,
  storedPlan,
} from "./fakes.ts";

const OWNER = "user-a";
const OTHER = "user-b";
const ID = "plan-1";

const CONFIG = {
  maxUploadBytes: 2 * 1024 * 1024,
  publicBaseUrl: "https://plans.example.test",
  uploadRateMax: 100,
  uploadRateWindowSec: 60,
};

const HTML = "<!doctype html><html><body><p>new</p></body></html>";

interface Written {
  objects: { key: string; size: number }[];
  sizes: number[];
  removed: string[];
  /**
   * Every object call in the order it happened. The three arrays above say
   * what was written and what was removed but not which came first, and for
   * the withdrawal path that is the whole property: a delete that ran before
   * the put would leave the bytes behind and read identically here.
   */
  log: string[];
}

function fakes(
  options: {
    /** Who the session resolves to; the handler authenticates itself now. */
    caller?: string;
    /** No row at all, rather than one belonging to somebody else. */
    missing?: boolean;
    /** A row deleted between the ownership check and the size update. */
    rowVanishes?: boolean;
    /** The account's deletion has begun, so the marker is already set. */
    closing?: boolean;
    storageFails?: boolean;
  } = {},
): { deps: ReplacePlanDeps; written: Written } {
  const written: Written = { objects: [], sizes: [], removed: [], log: [] };

  const storage: PlanStorage = {
    put: async (key, body) => {
      if (options.storageFails === true) throw new Error("bucket unreachable");
      written.log.push(`put:${key}`);
      written.objects.push({ key, size: body.byteLength });
    },
    get: async () => null,
    delete: async (key) => {
      written.log.push(`delete:${key}`);
      written.removed.push(key);
    },
    probe: async () => {},
  };

  const memory = memoryPlans(
    options.missing === true ? [] : [storedPlan({ id: ID, userId: OWNER })],
  );
  /*
   * A thin wrapper, not a second repository: `resize` is the one method whose
   * calls this suite has to see, and staging the concurrent delete means
   * refusing it while everything else - ownership above all - keeps answering
   * the way the SQL does.
   */
  const plans: MemoryPlans = {
    ...memory,
    resize: async (id, userId, size) => {
      if (options.rowVanishes === true) return false;
      if (!(await memory.resize(id, userId, size))) return false;
      written.sizes.push(size);
      return true;
    },
  };

  return {
    deps: {
      auth: fakeAuth({ sessionUser: options.caller ?? OWNER }).auth,
      config: CONFIG,
      plans,
      uploadRateLimits: openRateLimits,
      accountClosing:
        options.closing === true
          ? {
              open: async () => "attempt",
              close: async () => {},
              isOpen: async () => true,
            }
          : openAccounts,
      storage,
      logger: silentLogger,
    },
    written,
  };
}

function put(body = HTML): Request {
  return new Request(`https://example.test/api/plans/${ID}`, {
    method: "PUT",
    headers: { "content-type": "text/html" },
    body,
  });
}

describe("replacePlan", () => {
  test("writes the object, records the size, and echoes the unchanged URL", async () => {
    const { deps, written } = fakes();
    const response = await replacePlan(deps, put(), ID);

    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string; url: string }).toEqual({
      id: ID,
      url: `${CONFIG.publicBaseUrl}/p/${ID}`,
    });
    expect(written.objects).toEqual([{ key: ID, size: HTML.length }]);
    expect(written.sizes).toEqual([HTML.length]);
  });

  test("404s for another account's plan without touching its object", async () => {
    const { deps, written } = fakes({ caller: OTHER });
    const response = await replacePlan(deps, put(), ID);

    expect(response.status).toBe(404);
    expect(written).toEqual({ objects: [], sizes: [], removed: [], log: [] });
  });

  test("404s for an unknown id", async () => {
    const { deps, written } = fakes({ missing: true });
    const response = await replacePlan(deps, put(), ID);

    expect(response.status).toBe(404);
    // The whole record, like its siblings: asserting `objects` alone would let
    // a stray delete on the not-found path through unnoticed.
    expect(written).toEqual({ objects: [], sizes: [], removed: [], log: [] });
  });

  test("takes the object back out when the row goes away underneath it", async () => {
    const { deps, written } = fakes({ rowVanishes: true });
    const response = await replacePlan(deps, put(), ID);

    expect(response.status).toBe(404);
    expect(written.sizes).toEqual([]);
    // The invariant the ordering exists for: never leave a publicly served
    // object that no row owns. The write happened, so it has to be undone.
    expect(written.objects).toEqual([{ key: ID, size: HTML.length }]);
    expect(written.removed).toEqual([ID]);
    // In that order, which is the part that matters and the part the two
    // arrays above cannot show. A delete before the put would satisfy both
    // and still leave the object sitting there.
    expect(written.log).toEqual([`put:${ID}`, `delete:${ID}`]);
  });

  test("422s a document that is not standalone, leaving the plan alone", async () => {
    const { deps, written } = fakes();
    const html =
      '<!doctype html><html><body><script src="https://cdn.example.com/x.js"></script></body></html>';
    const response = await replacePlan(deps, put(html), ID);

    expect(response.status).toBe(422);
    expect(written).toEqual({ objects: [], sizes: [], removed: [], log: [] });
  });

  test("502s when the object write fails, leaving the row untouched", async () => {
    const { deps, written } = fakes({ storageFails: true });
    const response = await replacePlan(deps, put(), ID);

    expect(response.status).toBe(502);
    // Nothing was written, so nothing has to be undone: the plan still serves
    // its previous document at its previous recorded size.
    expect(written).toEqual({ objects: [], sizes: [], removed: [], log: [] });
  });

  /**
   * The marker read after the write, which is what stops a replacement
   * outliving the account it belongs to.
   *
   * The sweep removes an object before the row naming it, so a replacement
   * landing in that gap puts its bytes back and then loses the row - an object
   * at `/p/{id}` with no owner. `resize` cannot see it, because the row is
   * still there when it runs. tests/replace-delete-race.test.ts drives that
   * interleaving against the real sweep; this is the plain case, where the
   * marker is already set when the request arrives.
   */
  test("404s and withdraws its object once deletion has begun", async () => {
    const { deps, written } = fakes({ closing: true });

    const response = await replacePlan(deps, put(), ID);

    expect(response.status).toBe(404);
    // Written, then taken back out. The write is what makes the withdrawal
    // necessary, so a test asserting only the 404 would pass against a handler
    // that left the bytes behind.
    expect(written.objects).toEqual([{ key: ID, size: HTML.length }]);
    expect(written.removed).toEqual([ID]);
    // In that order. "Written, then taken back out" is the claim, and the two
    // arrays above hold either order equally well - a handler that deleted
    // first and wrote after would satisfy both and leave the bytes behind.
    expect(written.log).toEqual([`put:${ID}`, `delete:${ID}`]);
    // And the row is left for the sweep, which is already removing it.
    expect(written.sizes).toEqual([]);
  });
});
