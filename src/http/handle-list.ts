import type { PlanRepo } from "../services/types.ts";

/**
 * One or more account handles, as a caller supplies them.
 *
 * Shared by the two places a plan can be shared with named accounts: the
 * `?grants=` parameter on upload, where a query string is comma-separated by
 * nature, and the `handles` field of `POST /api/plans/{id}/grants`, which
 * accepts the same comma-separated string so the two read alike. A JSON caller
 * may send an array instead; entries in it are split too, so
 * `["a,b", "c"]` and `"a, b, c"` mean the same thing.
 */

/**
 * How many accounts one request may name.
 *
 * The work is one statement per handle, so this is what stops a single
 * authenticated request from turning into an unbounded number of them. Fifty
 * is far above what anyone shares a plan with by hand and far below anything
 * that costs the database noticeably.
 */
export const MAX_GRANTS_PER_REQUEST = 50;

/**
 * Room for the ceiling above at a generous handle length, plus the JSON
 * wrapper. Derived, so raising the count cannot leave the body bound refusing
 * a list this module would otherwise accept.
 */
export const MAX_HANDLE_LIST_BYTES = MAX_GRANTS_PER_REQUEST * 66 + 64;

export type HandleList =
  | { handles: string[] }
  /** The message to hand back with a 400. */
  | { error: string };

/**
 * Splits, trims, and de-duplicates a handle list.
 *
 * De-duplication is not politeness: granting the same handle twice is
 * idempotent in the repository, but the response reports what was granted, and
 * naming an account twice should not report it twice.
 */
export function parseHandleList(raw: unknown): HandleList {
  const parts: string[] = [];
  if (typeof raw === "string") {
    parts.push(raw);
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") {
        return { error: "handles must be strings" };
      }
      parts.push(entry);
    }
  } else {
    return { error: "handles is required" };
  }

  const handles: string[] = [];
  for (const part of parts) {
    for (const candidate of part.split(",")) {
      const handle = candidate.trim();
      // A trailing comma, or `a,,b`, is a typo rather than a request to grant
      // nothing - skipping is kinder than refusing the whole list for it.
      if (handle === "" || handles.includes(handle)) continue;
      handles.push(handle);
      if (handles.length > MAX_GRANTS_PER_REQUEST) {
        return {
          error: `at most ${MAX_GRANTS_PER_REQUEST} handles per request`,
        };
      }
    }
  }

  if (handles.length === 0) return { error: "handles is required" };
  return { handles };
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
  handles: string[],
): Promise<GrantOutcomes | null> {
  if ((await plans.findOwner(planId)) !== ownerId) return null;

  const granted: string[] = [];
  const unknown: string[] = [];

  for (const handle of handles) {
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
