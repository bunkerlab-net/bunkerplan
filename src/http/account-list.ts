import type { PlanRepo } from "../services/types.ts";

/**
 * One or more accounts, as a caller supplies them.
 *
 * An account is named by its handle - the value its owner reads off their own
 * dashboard - or by its account id, which `/api/auth/get-session` hands the
 * signed-in account and which a script may already hold. One field takes
 * either, because a caller should not have to say which kind it has; the
 * repository resolves an exact id first and only then a handle.
 *
 * Shared by the two places a plan can be shared with named accounts: the
 * `?grants=` parameter on upload, where a query string is comma-separated by
 * nature, and the `accounts` field of `POST /api/plans/{id}/grants`, which
 * accepts the same comma-separated string so the two read alike. A JSON
 * caller may send an array instead; entries in it are split too, so
 * `["a,b", "c"]` and `"a, b, c"` mean the same thing.
 */

/**
 * How many accounts one request may name.
 *
 * The work is one statement per account, so this is what stops a single
 * authenticated request from turning into an unbounded number of them. Fifty
 * is far above what anyone shares a plan with by hand and far below anything
 * that costs the database noticeably.
 */
export const MAX_GRANTS_PER_REQUEST = 50;

/**
 * Room for the ceiling above at a generous identifier length, plus the JSON
 * wrapper. Derived, so raising the count cannot leave the body bound refusing
 * a list this module would otherwise accept.
 */
export const MAX_ACCOUNT_LIST_BYTES = MAX_GRANTS_PER_REQUEST * 66 + 64;

export type AccountList =
  | { accounts: string[] }
  /** The message to hand back with a 400. */
  | { error: string };

/**
 * Splits, trims, and de-duplicates a handle list.
 *
 * De-duplication is not politeness: granting the same handle twice is
 * idempotent in the repository, but the response reports what was granted, and
 * naming an account twice should not report it twice.
 */
export function parseAccountList(raw: unknown): AccountList {
  const parts: string[] = [];
  if (typeof raw === "string") {
    parts.push(raw);
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") {
        return { error: "accounts must be strings" };
      }
      parts.push(entry);
    }
  } else {
    return { error: "accounts is required" };
  }

  const accounts: string[] = [];
  for (const part of parts) {
    for (const candidate of part.split(",")) {
      const handle = candidate.trim();
      // A trailing comma, or `a,,b`, is a typo rather than a request to grant
      // nothing - skipping is kinder than refusing the whole list for it.
      if (handle === "" || accounts.includes(handle)) continue;
      accounts.push(handle);
      if (accounts.length > MAX_GRANTS_PER_REQUEST) {
        return {
          error: `at most ${MAX_GRANTS_PER_REQUEST} accounts per request`,
        };
      }
    }
  }

  if (accounts.length === 0) return { error: "accounts is required" };
  return { accounts };
}

/** What naming a set of accounts did. */
export interface GrantOutcomes {
  /** Handles that now have access, including any that already did. */
  granted: string[];
  /** Handles no account answers to. Reported, not fatal. */
  unknown: string[];
}

/**
 * Grants each handle in turn, reporting which ones landed.
 *
 * `null` means the plan is not this caller's, which every route turns into a
 * 404.
 *
 * Ownership is resolved first, on its own, rather than being read off the
 * first `grantByHandle`. That call checks the handle before the plan, so an
 * unknown handle answers "no-user" whether or not the caller owns the plan -
 * and a stranger naming a handle that does not exist would otherwise get a
 * 200 describing their typo instead of the 404 that every other "not yours"
 * gets.
 *
 * An unknown handle is not an error once past that. Naming five colleagues
 * and mistyping one should share the plan with the four, and say so, rather
 * than refuse all five and make the owner work out which was wrong.
 */
export async function applyGrants(
  plans: Pick<PlanRepo, "findOwner" | "grantByHandle">,
  planId: string,
  ownerId: string,
  accounts: string[],
): Promise<GrantOutcomes | null> {
  if ((await plans.findOwner(planId)) !== ownerId) return null;

  const granted: string[] = [];
  const unknown: string[] = [];

  for (const handle of accounts) {
    switch (await plans.grantByHandle(planId, ownerId, handle)) {
      case "granted":
        granted.push(handle);
        break;
      case "no-user":
        unknown.push(handle);
        break;
      // Deleted between the ownership read and now. Rare, and the same
      // answer as never having owned it.
      case "no-plan":
        return null;
    }
  }

  return { granted, unknown };
}
