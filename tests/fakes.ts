import { pino } from "pino";
import type { AppAuth } from "../src/auth/instance.ts";
import type { PlanVisibility } from "../src/limits.ts";
import type {
  PlanAccessRow,
  PlanInsert,
  PlanRepo,
  PlanRow,
} from "../src/services/types.ts";

/**
 * The fakes every unit suite needs, in one place.
 *
 * Each of these was written out per suite, and the copies had already
 * drifted: two `fakeAuth`s counted calls and two did not, and five hand-rolled
 * `PlanRepo`s disagreed about what a repository does when a row is not the
 * caller's. A fake that differs between suites is a second specification
 * nobody maintains, so a handler that passes here and fails there reads as a
 * flake rather than as the disagreement it is.
 *
 * Everything here models the *repository* contract, not any one handler's
 * expectations. A suite that needs to count calls or stage a failure wraps
 * only what it needs and leaves the rest of the behaviour intact - see
 * tests/delete-plan.test.ts for the pattern.
 *
 * tests/app-harness.ts builds the whole app on top of these: it is these
 * fakes plus the real router, and is where a route-level test belongs.
 */

export const OWNER = "user-owner";
export const GRANTEE = "user-grantee";
export const STRANGER = "user-stranger";
export const PLAN_ID = "abcdefgh12345678";

/** Silent: these suites assert on responses and side effects, not on output. */
export const silentLogger = pino({ level: "silent" });

/**
 * A promise a test resolves by hand. It is how the race suites interleave two
 * requests deterministically rather than by luck.
 */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export interface AuthCalls {
  sessions: number;
  keys: number;
  handled: number;
}

/**
 * Only the endpoints the app touches. `AppAuth` is Better Auth's fully
 * inferred plugin-aware type - hundreds of endpoints that cannot be spelled
 * out here - so this is where a cast is the honest option.
 *
 * The counts are what make the session-only assertions mean anything: a
 * sharing handler that reached for `resolveUserId` where it should have used
 * `resolveSessionUserId` verifies a key, and `calls.keys` catches it.
 */
export function fakeAuth(
  over: {
    sessionUser?: string | null;
    keyUser?: string | null;
    handler?: (request: Request) => Promise<Response>;
  } = {},
): { auth: AppAuth; calls: AuthCalls } {
  const calls: AuthCalls = { sessions: 0, keys: 0, handled: 0 };
  const api = {
    getSession: async () => {
      calls.sessions += 1;
      const id = over.sessionUser ?? null;
      return id === null ? null : { user: { id } };
    },
    verifyApiKey: async () => {
      calls.keys += 1;
      const referenceId = over.keyUser ?? null;
      return referenceId === null
        ? { valid: false, key: null }
        : { valid: true, key: { referenceId } };
    },
  };
  const handler = async (request: Request): Promise<Response> => {
    calls.handled += 1;
    return over.handler === undefined
      ? new Response("better-auth", { status: 200 })
      : await over.handler(request);
  };
  return { auth: { api, handler } as unknown as AppAuth, calls };
}

export interface StoredPlan {
  id: string;
  userId: string;
  label: string | null;
  size: number;
  visibility: PlanVisibility;
  shareCodeHash: string | null;
  createdAt: Date;
  grants: string[];
}

export function storedPlan(over: Partial<StoredPlan> = {}): StoredPlan {
  return {
    id: PLAN_ID,
    userId: OWNER,
    label: null,
    size: 64,
    visibility: "private",
    shareCodeHash: null,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    grants: [],
    ...over,
  };
}

/** The repository plus the rows behind it, so a suite can assert on state. */
export type MemoryPlans = PlanRepo & { rows: Map<string, StoredPlan> };

/**
 * A `PlanRepo` over a Map.
 *
 * Real enough that ownership, the quota, and the rule that a *new* share code
 * requires a private plan behave the way the SQL does - a handler that skips
 * an ownership check fails here, rather than passing against a stub that
 * answers yes to everything. A visibility flip is deliberately not one of
 * those rules: `setVisibility` in src/db/plans.shared.ts leaves the hash
 * alone in both directions, so a public plan can carry a code it was minted
 * before the flip, and this keeps one too.
 *
 * `handles` maps a public handle to the account it names, which is the lookup
 * `grantByHandle` does against the `user` table. An empty map therefore means
 * every handle is unknown, which is the correct default: a suite that grants
 * has to say who exists.
 */
export function memoryPlans(
  seed: StoredPlan[] = [],
  handles: Record<string, string> = {},
): MemoryPlans {
  /*
   * Cloned, `grants` included. The repo mutates its rows - relabel, resize,
   * visibility, a grant added - and holding the caller's objects would edit the
   * fixture a test built, or a constant two tests share. A seed is an input, and
   * an input a callee rewrites is a fake teaching the wrong lesson.
   */
  const rows = new Map(
    seed.map((row) => [row.id, { ...row, grants: [...row.grants] }]),
  );
  const owned = (id: string, userId: string): StoredPlan | undefined => {
    const row = rows.get(id);
    return row?.userId === userId ? row : undefined;
  };
  /**
   * The handle naming an account, for `listGrantHandles`.
   *
   * Throws rather than falling back to the id. Production joins the `user`
   * table, so a grant naming an account with no row cannot come back from it;
   * a fixture that seeds one is modelling a state the repository cannot reach,
   * and answering with a plausible-looking handle would let that pass.
   */
  const handleOf = (userId: string): string => {
    const handle = Object.entries(handles).find(([, id]) => id === userId)?.[0];
    if (handle === undefined) {
      throw new Error(
        `memoryPlans: nothing in \`handles\` maps to ${userId}, so this grant ` +
          "names an account the fixture never created",
      );
    }
    return handle;
  };
  /**
   * The account a handle names, or `undefined`.
   *
   * `Object.hasOwn` rather than a bare index: `handles["__proto__"]` and
   * `handles["constructor"]` answer from the prototype, so a plain lookup
   * would resolve those two strings to something and hand a grant to a
   * "user id" that is a function. The real repositories match a row.
   */
  const accountFor = (handle: string): string | undefined =>
    Object.hasOwn(handles, handle) ? handles[handle] : undefined;

  return {
    rows,
    /*
     * `createdAt` is stamped here, not taken from `row`: `PlanRepo.insert` in
     * src/services/types.ts declares the row as `{ id, userId, label, size,
     * visibility, shareCodeHash }` with no `createdAt` in it, because both real
     * drivers let the column default in the database. A caller cannot pass one
     * through this signature, so there is nothing here to preserve.
     */
    insert: async (row, maxPlans): Promise<PlanInsert> => {
      if (rows.has(row.id)) return "duplicate";
      const held = [...rows.values()].filter(
        (item) => item.userId === row.userId,
      ).length;
      if (held >= maxPlans) return "quota";
      // `grants` cloned, as the seed path does: a row that kept the caller's
      // array would let a later `grantByHandle` write into an object the test
      // still holds, which is a fake editing its own input.
      const stored = { ...storedPlan(), ...row, createdAt: new Date() };
      rows.set(row.id, { ...stored, grants: [...stored.grants] });
      return "created";
    },
    /*
     * `createdAt` descending and nothing else, because that is the whole of the
     * `orderBy` both drivers issue (src/db/plans.pg.ts and plans.sqlite.ts).
     *
     * Two inserts inside one millisecond therefore tie, and neither the SQL nor
     * this says which comes back first. Deliberately not broken by insertion
     * order here: a fake that promises an ordering production does not have lets
     * a test depend on it and pass, which is the failure a fake is supposed to
     * prevent. Suites that care seed distinct timestamps.
     */
    listByUser: async (userId, limit): Promise<PlanRow[]> =>
      [...rows.values()]
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          label: row.label,
          size: row.size,
          createdAt: row.createdAt,
          visibility: row.visibility,
          hasShareCode: row.shareCodeHash !== null,
          hasGrants: row.grants.length > 0,
        })),
    findOwner: async (id) => rows.get(id)?.userId ?? null,
    relabel: async (id, userId, label) => {
      const row = owned(id, userId);
      if (row === undefined) return false;
      row.label = label;
      return true;
    },
    resize: async (id, userId, size) => {
      const row = owned(id, userId);
      if (row === undefined) return false;
      row.size = size;
      return true;
    },
    deleteOwned: async (id, userId) => {
      if (owned(id, userId) === undefined) return false;
      rows.delete(id);
      return true;
    },
    findAccess: async (id): Promise<PlanAccessRow | null> => {
      const row = rows.get(id);
      return row === undefined
        ? null
        : {
            ownerId: row.userId,
            visibility: row.visibility,
            shareCodeHash: row.shareCodeHash,
          };
    },
    hasGrant: async (planId, userId) =>
      rows.get(planId)?.grants.includes(userId) ?? false,
    setVisibility: async (id, userId, visibility) => {
      const row = owned(id, userId);
      if (row === undefined) return false;
      // Visibility alone: a share code and the grants outlive every flip.
      row.visibility = visibility;
      return true;
    },
    setShareCodeHash: async (id, userId, hash) => {
      const row = owned(id, userId);
      if (row === undefined) return false;
      // Minting requires the plan to be private, because a public plan needs no
      // new code; clearing is how a retained one is destroyed, at any
      // visibility.
      if (hash !== null && row.visibility === "public") return false;
      row.shareCodeHash = hash;
      return true;
    },
    listGrantHandles: async (planId, ownerId) =>
      owned(planId, ownerId)?.grants.map(handleOf) ?? null,
    grantByHandle: async (planId, ownerId, handle) => {
      const row = owned(planId, ownerId);
      if (row === undefined) return "no-plan";
      const userId = accountFor(handle);
      if (userId === undefined) return "no-user";
      if (!row.grants.includes(userId)) row.grants.push(userId);
      return "granted";
    },
    revokeByHandle: async (planId, ownerId, handle) => {
      const row = owned(planId, ownerId);
      const userId = accountFor(handle);
      if (row === undefined || userId === undefined) return false;
      const at = row.grants.indexOf(userId);
      if (at === -1) return false;
      row.grants.splice(at, 1);
      return true;
    },
  };
}
