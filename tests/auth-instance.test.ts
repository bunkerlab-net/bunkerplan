import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type AuthDb, createAuth } from "../src/auth/instance.ts";
import { EXPECTED_ACCOUNT_HEADER } from "../src/http/expected-account.ts";
import type { PlanStorage } from "../src/services/types.ts";
import {
  CONFIG,
  type MemoryStorage,
  memoryKv,
  memoryStorage,
  openRateLimits,
} from "./app-harness.ts";
import {
  memoryAccountClosing,
  memoryPlans,
  recordingLogger,
  storedPlan,
} from "./fakes.ts";

/**
 * The composition root.
 *
 * Everything it assembles is tested elsewhere - the options in
 * auth-options.test.ts, the sweep in account-sweep.test.ts, the KV adapter in
 * secondary-storage.test.ts - and none of that says the pieces were connected
 * to each other. Three wires exist only here: the session store, the delete
 * hook, and the sweep budget that hook is given. Each is a silent failure if
 * dropped - sessions land in the wrong place, an account deletion stops
 * sweeping, or a Workers invocation quietly stops respecting its subrequest
 * ceiling - and no existing suite would notice any of them.
 *
 * The database is a real drizzle handle with no tables in it: `drizzleAdapter`
 * has to be handed something it accepts, and nothing here queries through it.
 * The driver factories have contract suites of their own.
 */

const OWNER = "user-a";

interface Built {
  auth: ReturnType<typeof createAuth>;
  storage: MemoryStorage;
  kv: ReturnType<typeof memoryKv>;
  lines: ReturnType<typeof recordingLogger>["lines"];
}

function build(
  options: {
    plans?: string[];
    storage?: PlanStorage;
    maxSweepAttempts?: number;
  } = {},
): Built {
  const { logger, lines } = recordingLogger();
  const storage = memoryStorage();
  const plans = memoryPlans(
    (options.plans ?? []).map((id) => storedPlan({ id, userId: OWNER })),
  );
  for (const id of options.plans ?? []) {
    storage.objects.set(id, new TextEncoder().encode("<p>x</p>"));
  }
  const db: AuthDb = {
    adapter: drizzle(new Database(":memory:")),
    provider: "sqlite",
    plans,
    uploadRateLimits: openRateLimits,
    unlockRateLimits: openRateLimits,
    accountClosing: memoryAccountClosing(),
    probe: async () => {},
  };
  const kv = memoryKv();
  return {
    auth: createAuth({
      config: CONFIG,
      db,
      kv,
      storage: options.storage ?? storage,
      logger,
      ...(options.maxSweepAttempts === undefined
        ? {}
        : { maxSweepAttempts: options.maxSweepAttempts }),
    }),
    storage,
    kv,
    lines,
  };
}

/** The hook Better Auth calls, reached the way Better Auth reaches it. */
function beforeDelete(
  auth: ReturnType<typeof createAuth>,
): (user: { id: string }, request?: Request) => Promise<void> {
  const hook = auth.options.user?.deleteUser?.beforeDelete;
  if (hook === undefined) throw new Error("no beforeDelete hook was wired");
  return hook;
}

function deleting(userId: string): Request {
  return new Request("https://plans.example.test/api/auth/delete-user", {
    method: "POST",
    headers: { [EXPECTED_ACCOUNT_HEADER]: userId },
  });
}

describe("createAuth", () => {
  test("routes session storage at the KV it was given", async () => {
    const { auth, kv } = build();
    const secondary = auth.options.secondaryStorage;
    if (secondary == null) throw new Error("no secondaryStorage was wired");

    await secondary.set("sess:1", "stored", 120);

    expect(await kv.get("sess:1")).toBe("stored");
  });

  /**
   * Sign-out is the other half, and it goes through the same wire. A session
   * that is removed from Better Auth's view but left in KV is a credential
   * that outlives the request revoking it.
   */
  test("revokes a session through the same KV", async () => {
    const { auth, kv } = build();
    const secondary = auth.options.secondaryStorage;
    if (secondary == null) throw new Error("no secondaryStorage was wired");

    await secondary.set("sess:1", "stored", 120);
    await secondary.delete("sess:1");

    expect(await kv.get("sess:1")).toBeNull();
  });

  test("sweeps the account's objects before the rows are deleted", async () => {
    const { auth, storage } = build({ plans: ["p1", "p2"] });

    await beforeDelete(auth)({ id: OWNER }, deleting(OWNER));

    expect([...storage.objects.keys()]).toEqual([]);
  });

  /**
   * The header check runs first, and a refusal must leave the account exactly
   * as it was. A sweep that ran anyway would destroy the objects of an account
   * this request was never allowed to touch.
   */
  test.each([
    ["no header at all", undefined],
    ["another account's id", "user-b"],
  ])("refuses %s without sweeping anything", async (_label, expected) => {
    const { auth, storage } = build({ plans: ["p1"] });
    const request = new Request("https://plans.example.test/api/auth/x", {
      method: "POST",
      headers:
        expected === undefined ? {} : { [EXPECTED_ACCOUNT_HEADER]: expected },
    });

    await expect(beforeDelete(auth)({ id: OWNER }, request)).rejects.toThrow();

    expect([...storage.objects.keys()]).toEqual(["p1"]);
  });

  /**
   * A storage failure has to abort the deletion. Better Auth deletes the rows
   * naming the objects once this returns, so an object left behind with its
   * row gone is a byte nothing can reach and nobody can find.
   */
  test("a storage failure aborts the deletion", async () => {
    const storage = memoryStorage();
    const { auth } = build({
      plans: ["p1"],
      storage: {
        ...storage,
        delete: async () => {
          throw new Error("bucket unreachable");
        },
      },
    });

    await expect(
      beforeDelete(auth)({ id: OWNER }, deleting(OWNER)),
    ).rejects.toThrow("bucket unreachable");
  });

  /**
   * The Workers subrequest budget, which only this wiring passes on. A process
   * with no ceiling must not inherit one, and a process with one must not
   * silently exceed it, so the number has to arrive at the sweep rather than
   * being dropped in between.
   */
  test("carries the sweep budget it was constructed with", async () => {
    const { auth, storage } = build({
      plans: ["p1", "p2", "p3"],
      maxSweepAttempts: 2,
    });

    await expect(
      beforeDelete(auth)({ id: OWNER }, deleting(OWNER)),
    ).rejects.toThrow();

    // Two spent, one left: the budget was obeyed rather than ignored, and the
    // deletion was refused rather than reporting an account it did not empty.
    expect(storage.objects.size).toBe(1);
  });

  /** No budget means no ceiling, which is what every non-Workers process gets. */
  test("sweeps an account past any one invocation's budget when given none", async () => {
    const { auth, storage } = build({
      plans: ["p1", "p2", "p3", "p4", "p5"],
    });

    await beforeDelete(auth)({ id: OWNER }, deleting(OWNER));

    expect(storage.objects.size).toBe(0);
  });
});
