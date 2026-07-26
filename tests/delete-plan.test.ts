import { describe, expect, test } from "bun:test";
import { pino } from "pino";
import { deletePlan } from "../src/http/delete-plan.ts";
import type { PlanRepo, PlanStorage } from "../src/services/types.ts";

const OWNER = "user-a";
const OTHER = "user-b";
const ID = "plan-1";

interface Fakes {
  storage: PlanStorage;
  plans: PlanRepo;
  /** What happened, and in which order. */
  deleted: { objects: string[]; rows: string[]; order: string[] };
}

function fakes(
  options: {
    owner?: string | null;
    storageFails?: boolean;
    /** Only the closing sweep throws, after the row is already gone. */
    sweepFails?: boolean;
  } = {},
) {
  const owner = options.owner === undefined ? OWNER : options.owner;
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

  const plans: PlanRepo = {
    insert: async () => true,
    listByUser: async () => [],
    findOwner: async () => owner,
    relabel: async () => false,
    resize: async () => false,
    deleteOwned: async (id, userId) => {
      if (owner !== userId) return false;
      deleted.rows.push(id);
      deleted.order.push("row");
      return true;
    },
  };

  return { storage, plans, deleted } satisfies Fakes;
}

/** Silent: these tests assert on responses and side effects, not on output. */
const logger = pino({ level: "silent" });

describe("deletePlan", () => {
  test("removes the object and the row, then sweeps and 204s", async () => {
    const { storage, plans, deleted } = fakes();
    const response = await deletePlan(storage, plans, logger, ID, OWNER);
    expect(response.status).toBe(204);
    // The sweep is only worth anything after the row is gone: an object a
    // concurrent replacement wrote can only be removed by a pass that follows
    // the row delete, so the order is the assertion.
    expect(deleted.order).toEqual(["object", "row", "object"]);
    expect(deleted.rows).toEqual([ID]);
  });

  test("still 204s when the closing sweep fails", async () => {
    const { storage, plans, deleted } = fakes({ sweepFails: true });
    const response = await deletePlan(storage, plans, logger, ID, OWNER);
    expect(response.status).toBe(204);
    expect(deleted.rows).toEqual([ID]);
  });

  test("404s for another account's plan without touching storage", async () => {
    const { storage, plans, deleted } = fakes();
    const response = await deletePlan(storage, plans, logger, ID, OTHER);
    expect(response.status).toBe(404);
    expect(deleted.objects).toEqual([]);
    expect(deleted.rows).toEqual([]);
  });

  test("404s for an unknown id", async () => {
    const { storage, plans } = fakes({ owner: null });
    expect((await deletePlan(storage, plans, logger, ID, OWNER)).status).toBe(
      404,
    );
  });

  test("keeps the row when the object delete fails, so a retry works", async () => {
    const { storage, plans, deleted } = fakes({ storageFails: true });
    const response = await deletePlan(storage, plans, logger, ID, OWNER);
    expect(response.status).toBe(502);
    // The invariant: never leave a publicly served object with no owning row.
    expect(deleted.rows).toEqual([]);
  });
});
