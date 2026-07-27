import { describe, expect, test } from "bun:test";
import { pino } from "pino";
import { storeAndConfirm } from "../src/http/store-plan.ts";
import {
  type AccountClosingRepo,
  PLAN_PAGE_SIZE,
  type PlanRepo,
  type PlanStorage,
} from "../src/services/types.ts";
import { basePlanRepoStub } from "./plan-repo-stub.ts";

/**
 * Uploading claims a row and then writes the object. Deleting an account marks
 * the account, sweeps the objects its rows name, and lets the foreign key take
 * the rows - and the marker, which cascades with the user too.
 *
 * Interleaved wrongly, the object write lands after the sweep passed and the
 * object outlives its row: served at `/p/{id}`, owned by nobody, reachable by
 * nothing. These drive each interleaving by hand against the real
 * `storeAndConfirm`, because the two checks it makes guard different ones and
 * a test that reimplemented it would prove nothing about either.
 */

const OWNER = "user-a";
const ID = "plan-1";

/** Silent: these assert on stored state, not output. */
const logger = pino({ level: "silent" });

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
        .map(([id]) => ({
          id,
          label: null,
          size: 0,
          createdAt: new Date(),
          visibility: "private" as const,
          hasShareCode: false,
        })),
    findOwner: async (id) => rows.get(id)?.userId ?? null,
    relabel: async () => false,
    resize: async () => false,
    deleteOwned: async (id, userId) => {
      if (rows.get(id)?.userId !== userId) return false;
      rows.delete(id);
      return true;
    },
    ...basePlanRepoStub,
  };

  const accountClosing: AccountClosingRepo = {
    open: async (userId) => {
      closing.add(userId);
    },
    isOpen: async (userId) => closing.has(userId),
  };

  const deps = { storage, plans, accountClosing, logger };
  return { objects, rows, closing, deps, plans, storage, entered, released };
}

/** The sweep `src/auth/instance.ts` performs, before the cascade. */
async function sweep(
  deps: {
    plans: PlanRepo;
    storage: PlanStorage;
    accountClosing: AccountClosingRepo;
  },
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
}

/**
 * What Better Auth's `deleteUser` does after the hook returns: the foreign key
 * removes every row that references the user - the plan rows AND the closing
 * marker, which is the case the marker check alone cannot see.
 */
function cascade(
  rows: Map<string, { userId: string }>,
  closing: Set<string>,
  userId: string,
): void {
  for (const [id, row] of rows) if (row.userId === userId) rows.delete(id);
  closing.delete(userId);
}

async function claim(plans: PlanRepo, id: string): Promise<void> {
  expect(
    await plans.insert(
      {
        id,
        userId: OWNER,
        label: null,
        size: 5,
        visibility: "private",
        shareCodeHash: null,
      },
      10,
    ),
  ).toBe("created");
}

describe("upload racing account deletion", () => {
  /** Deletion still running: the marker is what catches this one. */
  test("withdraws when the sweep runs mid-write", async () => {
    const { objects, rows, closing, deps, plans, entered, released } =
      stores(true);
    await claim(plans, ID);

    const upload = storeAndConfirm(deps, ID, OWNER, new Uint8Array(5));

    await entered.promise;
    await sweep(deps, OWNER);
    released.resolve();

    expect(await upload).toBe("withdrawn");
    expect([...objects.keys()]).toEqual([]);
    expect(rows.size).toBe(0);
    expect(closing.has(OWNER)).toBe(true);
  });

  /**
   * Deletion COMPLETED mid-write. The marker has cascaded away by the time the
   * upload resumes, so checking it alone reads as "all clear" for a plan whose
   * row is already gone. Only the ownership check catches this.
   */
  test("withdraws when the deletion completes mid-write", async () => {
    const { objects, rows, closing, deps, plans, entered, released } =
      stores(true);
    await claim(plans, ID);

    const upload = storeAndConfirm(deps, ID, OWNER, new Uint8Array(5));

    await entered.promise;
    await sweep(deps, OWNER);
    cascade(rows, closing, OWNER);
    released.resolve();

    // The marker is gone, so this can only pass on the ownership check.
    expect(closing.has(OWNER)).toBe(false);
    expect(await upload).toBe("withdrawn");
    expect([...objects.keys()]).toEqual([]);
  });

  test("keeps the plan when nothing is racing it", async () => {
    const { objects, rows, deps, plans } = stores();
    await claim(plans, ID);

    expect(
      await storeAndConfirm(deps, ID, OWNER, new Uint8Array(5)),
    ).toBeNull();
    expect([...objects.keys()]).toEqual([ID]);
    expect(rows.size).toBe(1);
  });

  test("reports a storage failure without leaving the row behind", async () => {
    const { rows, deps, plans } = stores();
    await claim(plans, ID);
    deps.storage.put = async () => {
      throw new Error("bucket unreachable");
    };

    expect(await storeAndConfirm(deps, ID, OWNER, new Uint8Array(5))).toBe(
      "storage-unavailable",
    );
    expect(rows.size).toBe(0);
  });

  /**
   * Withdrawing deletes the object before the row, and keeps the row if that
   * fails. The row is the only handle anything has on the object - the sweep
   * loops until no rows remain, so a surviving row means the object is retried
   * on the next pass, while dropping it first strands the object where nothing
   * will look again.
   */
  test("keeps the row when withdrawing cannot remove the object", async () => {
    const { rows, deps, plans, closing } = stores();
    await claim(plans, ID);
    closing.add(OWNER);
    deps.storage.delete = async () => {
      throw new Error("bucket unreachable");
    };

    expect(await storeAndConfirm(deps, ID, OWNER, new Uint8Array(5))).toBe(
      "withdrawn",
    );
    // Left deliberately, so the next sweep pass retries the object.
    expect(rows.size).toBe(1);
  });

  test("clears every object when the sweep spans more than one page", async () => {
    const { objects, rows, deps, plans, storage } = stores();

    for (let i = 0; i < 5; i += 1) {
      await plans.insert(
        {
          id: `p${i}`,
          userId: OWNER,
          label: null,
          size: 1,
          visibility: "private",
          shareCodeHash: null,
        },
        100,
      );
      await storage.put(`p${i}`, new Uint8Array(1));
    }
    expect(objects.size).toBe(5);

    await sweep(deps, OWNER);
    expect([...objects.keys()]).toEqual([]);
    expect(rows.size).toBe(0);
  });

  test("leaves another account's plans alone", async () => {
    const { objects, deps, plans, storage } = stores();

    await claim(plans, "mine");
    await storage.put("mine", new Uint8Array(1));
    await plans.insert(
      {
        id: "theirs",
        userId: "user-b",
        label: null,
        size: 1,
        visibility: "private",
        shareCodeHash: null,
      },
      10,
    );
    await storage.put("theirs", new Uint8Array(1));

    await sweep(deps, OWNER);

    expect([...objects.keys()]).toEqual(["theirs"]);
    expect(await deps.accountClosing.isOpen("user-b")).toBe(false);
  });
});
