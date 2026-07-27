import type { AppAuth } from "../auth/instance.ts";
import { MAX_SHARE_CODE_LENGTH } from "../config.ts";
import { isPlanId } from "../ids.ts";
import type { PlanRepo, PlanVisibility } from "../services/types.ts";
import { readBoundedBody } from "./bounded-body.ts";
import { problem } from "./problem.ts";
import { resolveUserId } from "./require-user.ts";
import {
  mintShareCookie,
  type ShareCookieConfig,
  shareCodeMatches,
  verifyShareCookie,
} from "./share-auth.ts";

/**
 * Who may read a plan, and the endpoint that trades a share code for a cookie.
 *
 * Every plan is private unless its owner said otherwise, so `/p/{id}` can no
 * longer be a bare object read. What replaces it is one row read and, only
 * when that row says the plan is not public, at most one credential lookup.
 */

/**
 * The longest `?code=` this will hash, taken from the same constant that caps
 * a minted one so the two cannot drift.
 *
 * Deliberately the ceiling rather than `config.shareCodeLength`: an operator
 * may lower that setting, and codes minted under the old one must keep
 * working. Same looseness, for the same reason, as the plan-id bound in
 * src/ids.ts.
 */
const MAX_CODE_LENGTH = MAX_SHARE_CODE_LENGTH;

/**
 * Room for `{"code":"…"}` at the longest code, and nothing more. Derived, so
 * raising the ceiling cannot leave this refusing bodies that carry a valid
 * code. The slack covers the JSON wrapper, whitespace, and any percent
 * encoding the transport adds.
 */
const MAX_UNLOCK_BODY_BYTES = MAX_SHARE_CODE_LENGTH * 3 + 64;

export type PlanAccess =
  | {
      kind: "granted";
      /** Decides the cache headers, so it is carried out of here. */
      visibility: PlanVisibility;
      /** Present only when `?code=` was what granted access. */
      setCookie?: string;
    }
  /** The plan exists but this visitor may not read it. */
  | { kind: "gate"; hasCode: boolean }
  | { kind: "missing" };

/**
 * Decides access, stopping at the first thing that grants it.
 *
 * The order is a cost order. A public plan and a returning code holder never
 * reach a credential lookup at all; an API client sends `x-api-key` and never
 * reaches `getSession`. Only a browser holding a session pays for one.
 */
export async function resolvePlanAccess(
  auth: AppAuth,
  plans: PlanRepo,
  config: ShareCookieConfig,
  request: Request,
  planId: string,
): Promise<PlanAccess> {
  // Only ids this app could have issued are routable, so a path carrying a
  // percent-encoded separator never reaches storage.
  if (!isPlanId(planId)) return { kind: "missing" };

  const row = await plans.findAccess(planId);
  if (row === null) return { kind: "missing" };
  if (row.visibility === "public") {
    return { kind: "granted", visibility: "public" };
  }

  const storedHash = row.shareCodeHash;
  if (storedHash !== null) {
    const code = new URL(request.url).searchParams.get("code");
    // A wrong code falls through rather than short-circuiting to the gate: an
    // owner who follows a stale link must still get in on their own
    // credential.
    if (
      code !== null &&
      code.length <= MAX_CODE_LENGTH &&
      (await shareCodeMatches(code, storedHash))
    ) {
      return {
        kind: "granted",
        visibility: "private",
        // So the next request to this plan works without the parameter.
        setCookie: await mintShareCookie(
          config,
          planId,
          storedHash,
          Date.now(),
        ),
      };
    }

    if (
      await verifyShareCookie(
        config.secret,
        planId,
        storedHash,
        request.headers.get("cookie"),
        Date.now(),
      )
    ) {
      return { kind: "granted", visibility: "private" };
    }
  }

  const userId = await resolveUserId(auth, request);
  if (userId === null) return { kind: "gate", hasCode: storedHash !== null };
  if (userId === row.ownerId) {
    return { kind: "granted", visibility: "private" };
  }
  if (await plans.hasGrant(planId, userId)) {
    return { kind: "granted", visibility: "private" };
  }

  return { kind: "gate", hasCode: storedHash !== null };
}

/**
 * Trades a share code for the unlock cookie.
 *
 * Unauthenticated and deliberately unthrottled. A code is about 95 bits at the
 * floor, so a limiter adds nothing against guessing it, and this handler is
 * cheaper than `GET /p/{id}` - unauthenticated too, and additionally reading
 * an object - so a counter here closes no gap that one leaves open. Neither
 * existing counter could hold the bucket anyway: `upload_rate_limit.key` is a
 * foreign key onto `user.id`, and that cascade is the only thing pruning the
 * table. Keyed on the plan alone a limiter is itself the attack, letting a
 * passer-by lock the owner's share link out.
 */
export async function unlockPlan(
  plans: PlanRepo,
  config: ShareCookieConfig,
  request: Request,
  planId: string,
): Promise<Response> {
  // One 400 covers every way the body can fail, because they all mean the
  // same thing to the only caller: the gate page's fetch. The bound is not a
  // separate contract - a code cannot exceed the ceiling above, so a body too
  // large to read cannot have held one, and this endpoint is unauthenticated.
  const encoded = await readBoundedBody(request, MAX_UNLOCK_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(encoded ?? new Uint8Array(0)));
  } catch {
    return problem(400, "code is required");
  }

  if (typeof body !== "object" || body === null || !("code" in body)) {
    return problem(400, "code is required");
  }
  const code = body.code;
  if (typeof code !== "string" || code === "") {
    return problem(400, "code is required");
  }

  const row = isPlanId(planId) ? await plans.findAccess(planId) : null;
  // A plan with no code is indistinguishable from one that does not exist:
  // this endpoint must not report which private plans are code-shared.
  if (row === null || row.shareCodeHash === null) {
    return problem(404, "not found");
  }

  if (
    code.length > MAX_CODE_LENGTH ||
    !(await shareCodeMatches(code, row.shareCodeHash))
  ) {
    return problem(401, "invalid code");
  }

  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": await mintShareCookie(
        config,
        planId,
        row.shareCodeHash,
        Date.now(),
      ),
    },
  });
}
