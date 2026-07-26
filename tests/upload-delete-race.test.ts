import { describe, expect, test } from "bun:test";
import type {
  AccountClosingRepo,
  PlanRepo,
  PlanStorage,
} from "../src/services/types.ts";
import { PLAN_PAGE_SIZE } from "../src/services/types.ts";

/**
 * Uploading claims a row and then writes the object. Deleting an account marks
 * the account, sweeps the objects its rows name, and lets the foreign key take
 * the rows.
 *
 * Interleave those and the object write can land after the sweep has passed -
 * leaving an object served at `/p/{id}` that no row owns and no code path can
 * reach, which is exactly the state the upload and delete paths both say must
 * never occur. Confirming the row still exists after the write does NOT close
 * it: the row is still there right up until the cascade, so the check passes
 * and the object is stranded a moment later. The marker is what closes it.
 *
 * These drive the interleavings by hand rather than hoping for them.
 */

const OWNER = "user-a";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function stores(holdPut = false) {
  const objects = new Map<string, number>();
  const rows = new Map<string, { userId: string }>();
  const closing = new Set<string>();

  const entered = deferred();
  const released = deferred();

  const storage: PlanStorage = {
    put: async (key, body) => {
      if (holdPut) {
        entered.resolve();
        await released.promise;
      }
      objects.set(key, body.byteLength);
    },
    get: async () => null,
    delete: async (key) => {
      objects.delete(key);
    },
    probe: async () => {},
  };

  const plans: PlanRepo = {
    insert: async (row) => {
      if (rows.has(row.id)) return "duplicate";
      rows.set(row.id, { userId: row.userId });
      return "created";
    },
    listByUser: async (userId) =>
      [...rows.entries()]
        .filter(([, row]) => row.userId === userId)
        .map(([id]) => ({ id, label: null, size: 0, createdAt: new Date() })),
    findOwner: async (id) => rows.get(id)?.userId ?? null,
    relabel: async () => false,
    resize: async () => false,
    deleteOwned: async (id, userId) => {
      if (rows.get(id)?.userId !== userId) return false;
      rows.delete(id);
      return true;
    },
  };

  const accountClosing: AccountClosingRepo = {
    open: async (userId) => {
      closing.add(userId);
    },
    isOpen: async (userId) => closing.has(userId),
  };

  return { objects, rows, storage, plans, accountClosing, entered, released };
}

/**
 * The sweep `onBeforeDeleteUser` performs, then the cascade Better Auth's
 * `deleteUser` triggers afterwards. Mirrors src/auth/instance.ts.
 */
async function deleteAccount(
  deps: {
    plans: PlanRepo;
    storage: PlanStorage;
    accountClosing: AccountClosingRepo;
  },
  rows: Map<string, { userId: string }>,
  userId: string,
): Promise<void> {
  await deps.accountClosing.open(userId);
  for (;;) {
    const page = await deps.plans.listByUser(userId, PLAN_PAGE_SIZE);
    if (page.length === 0) break;
    for (const row of page) {
      await deps.storage.delete(row.id);
      await deps.plans.deleteOwned(row.id, userId);
    }
  }
  // The foreign key removes anything that appeared after the last page.
  for (const [id, row] of rows) if (row.userId === userId) rows.delete(id);
}

describe("upload racing account deletion", () => {
  /**
   * The interleaving that post-write confirmation could not catch: the sweep
   * runs to completion, the upload's row is still present when it would have
   * checked, and only then does the cascade remove it.
   */
  test("strands no object when the sweep completes mid-write", async () => {
    const { objects, rows, storage, plans, accountClosing, entered, released } =
      stores(true);

    expect(
      await plans.insert({ id: "p1", userId: OWNER, label: null, size: 5 }, 10),
    ).toBe("created");

    const upload = (async () => {
      await storage.put("p1", new Uint8Array(5));
      // What createPlan does after the write.
      if (!(await accountClosing.isOpen(OWNER))) return "kept";
      await plans.deleteOwned("p1", OWNER);
      await storage.delete("p1");
      return "withdrawn";
    })();

    await entered.promise;
    await deleteAccount({ plans, storage, accountClosing }, rows, OWNER);
    released.resolve();

    expect(await upload).toBe("withdrawn");
    expect(rows.size).toBe(0);
    // The assertion that matters: nothing survives that nothing owns.
    expect([...objects.keys()]).toEqual([]);
  });

  test("keeps the object when nothing is racing it", async () => {
    const { objects, storage, plans, accountClosing } = stores();

    await plans.insert({ id: "p1", userId: OWNER, label: null, size: 5 }, 10);
    await storage.put("p1", new Uint8Array(5));

    expect(await accountClosing.isOpen(OWNER)).toBe(false);
    expect([...objects.keys()]).toEqual(["p1"]);
  });

  test("refuses a fresh upload once deletion has begun", async () => {
    const { rows, storage, plans, accountClosing } = stores();
    await deleteAccount({ plans, storage, accountClosing }, rows, OWNER);

    // The admission check createPlan performs before claiming an id.
    expect(await accountClosing.isOpen(OWNER)).toBe(true);
  });

  test("clears every object when the sweep spans more than one page", async () => {
    const { objects, rows, storage, plans, accountClosing } = stores();

    for (let i = 0; i < 5; i += 1) {
      await plans.insert(
        { id: `p${i}`, userId: OWNER, label: null, size: 1 },
        100,
      );
      await storage.put(`p${i}`, new Uint8Array(1));
    }
    expect(objects.size).toBe(5);

    await deleteAccount({ plans, storage, accountClosing }, rows, OWNER);
    expect([...objects.keys()]).toEqual([]);
    expect(rows.size).toBe(0);
  });

  test("leaves another account's plans alone", async () => {
    const { objects, rows, storage, plans, accountClosing } = stores();

    await plans.insert({ id: "mine", userId: OWNER, label: null, size: 1 }, 10);
    await storage.put("mine", new Uint8Array(1));
    await plans.insert(
      { id: "theirs", userId: "user-b", label: null, size: 1 },
      10,
    );
    await storage.put("theirs", new Uint8Array(1));

    await deleteAccount({ plans, storage, accountClosing }, rows, OWNER);

    expect([...objects.keys()]).toEqual(["theirs"]);
    expect(await accountClosing.isOpen("user-b")).toBe(false);
  });
});
