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
  deleted: { objects: string[]; rows: string[] };
}

function fakes(
  options: { owner?: string | null; storageFails?: boolean } = {},
) {
  const owner = options.owner === undefined ? OWNER : options.owner;
  const deleted: Fakes["deleted"] = { objects: [], rows: [] };

  const storage: PlanStorage = {
    put: async () => {},
    get: async () => null,
    delete: async (key) => {
      if (options.storageFails === true) throw new Error("bucket unreachable");
      deleted.objects.push(key);
    },
    probe: async () => {},
  };

  const plans: PlanRepo = {
    insert: async () => true,
    listByUser: async () => [],
    findOwner: async () => owner,
    deleteOwned: async (id, userId) => {
      if (owner !== userId) return false;
      deleted.rows.push(id);
      return true;
    },
  };

  return { storage, plans, deleted } satisfies Fakes;
}

/** Silent: these tests assert on responses and side effects, not on output. */
const logger = pino({ level: "silent" });

describe("deletePlan", () => {
  test("removes the object and the row, then 204", async () => {
    const { storage, plans, deleted } = fakes();
    const response = await deletePlan(storage, plans, logger, ID, OWNER);
    expect(response.status).toBe(204);
    expect(deleted).toEqual({ objects: [ID], rows: [ID] });
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
