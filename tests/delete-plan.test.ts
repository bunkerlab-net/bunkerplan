import { describe, expect, test } from "bun:test";
import type { AppAuth } from "../src/auth/instance.ts";
import { deletePlan } from "../src/http/delete-plan.ts";
import type { PlanStorage } from "../src/services/types.ts";
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

interface Fakes {
  auth: AppAuth;
  storage: PlanStorage;
  plans: MemoryPlans;
  /** What happened, and in which order. */
  deleted: { objects: string[]; rows: string[]; order: string[] };
}

function fakes(
  options: {
    /** Who the session resolves to; the handler authenticates itself now. */
    caller?: string;
    /** No row at all, rather than one belonging to somebody else. */
    missing?: boolean;
    storageFails?: boolean;
    /** Only the closing sweep throws, after the row is already gone. */
    sweepFails?: boolean;
  } = {},
): Fakes {
  const deleted: Fakes["deleted"] = { objects: [], rows: [], order: [] };

  const storage: PlanStorage = {
    put: async () => {},
    get: async () => null,
    delete: async (key) => {
      if (options.storageFails === true) throw new Error("bucket unreachable");
      if (options.sweepFails === true && deleted.rows.length > 0) {
        throw new Error("bucket unreachable");
      }
      deleted.objects.push(key);
      deleted.order.push("object");
    },
    probe: async () => {},
  };

  // A thin wrapper over the shared repository, not another one: only
  // `deleteOwned` is recorded, and it still refuses a row that is not the
  // caller's exactly as the SQL does.
  const memory = memoryPlans(
    options.missing === true ? [] : [storedPlan({ id: ID, userId: OWNER })],
  );
  const plans: MemoryPlans = {
    ...memory,
    deleteOwned: async (id, userId) => {
      if (!(await memory.deleteOwned(id, userId))) return false;
      deleted.rows.push(id);
      deleted.order.push("row");
      return true;
    },
  };

  return {
    auth: fakeAuth({ sessionUser: options.caller ?? OWNER }).auth,
    storage,
    plans,
    deleted,
  };
}

const del = (): Request =>
  new Request(`https://plans.example.test/api/plans/${ID}`, {
    method: "DELETE",
  });

describe("deletePlan", () => {
  test("removes the object and the row, then sweeps and 204s", async () => {
    const { auth, storage, plans, deleted } = fakes();
    const response = await deletePlan(
      auth,
      storage,
      plans,
      silentLogger,
      del(),
      ID,
    );
    expect(response.status).toBe(204);
    // The sweep is only worth anything after the row is gone: an object a
    // concurrent replacement wrote can only be removed by a pass that follows
    // the row delete, so the order is the assertion.
    expect(deleted.order).toEqual(["object", "row", "object"]);
    expect(deleted.rows).toEqual([ID]);
  });

  test("still 204s when the closing sweep fails", async () => {
    const { auth, storage, plans, deleted } = fakes({ sweepFails: true });
    const response = await deletePlan(
      auth,
      storage,
      plans,
      silentLogger,
      del(),
      ID,
    );
    expect(response.status).toBe(204);
    expect(deleted.rows).toEqual([ID]);
  });

  test("404s for another account's plan without touching storage", async () => {
    const { auth, storage, plans, deleted } = fakes({ caller: OTHER });
    const response = await deletePlan(
      auth,
      storage,
      plans,
      silentLogger,
      del(),
      ID,
    );
    expect(response.status).toBe(404);
    expect(deleted.objects).toEqual([]);
    expect(deleted.rows).toEqual([]);
  });

  test("404s for an unknown id", async () => {
    const { auth, storage, plans } = fakes({ missing: true });
    expect(
      (await deletePlan(auth, storage, plans, silentLogger, del(), ID)).status,
    ).toBe(404);
  });

  test("keeps the row when the object delete fails, so a retry works", async () => {
    const { auth, storage, plans, deleted } = fakes({ storageFails: true });
    const response = await deletePlan(
      auth,
      storage,
      plans,
      silentLogger,
      del(),
      ID,
    );
    expect(response.status).toBe(502);
    // The invariant: never leave a publicly served object with no owning row.
    expect(deleted.rows).toEqual([]);
  });
});
