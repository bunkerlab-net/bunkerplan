import { describe, expect, test } from "bun:test";
import { deletePlan } from "../src/http/delete-plan.ts";
import { replacePlan } from "../src/http/replace-plan.ts";
import type { PlanStorage } from "../src/services/types.ts";
import { openRateLimits } from "./app-harness.ts";
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
 * Both stores, in memory, with a hold on the first object delete so the two
 * requests can be interleaved by hand rather than by luck.
 */
function stores() {
  const objects = new Map<string, number>();
  objects.set(ID, 10);

  const entered = deferred();
  const released = deferred();
  let deletes = 0;

  const storage: PlanStorage = {
    put: async (key, body) => {
      objects.set(key, body.byteLength);
    },
    get: async () => null,
    delete: async (key) => {
      objects.delete(key);
      deletes += 1;
      if (deletes === 1) {
        entered.resolve();
        await released.promise;
      }
    },
    probe: async () => {},
  };

  const plans = memoryPlans([storedPlan({ id: ID, userId: OWNER, size: 10 })]);

  return {
    objects,
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
    const { objects, rows, storage, plans, auth, hold } = stores();

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
