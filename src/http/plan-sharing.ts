import type { PlanSharing, ShareCodeCreated } from "../api/schemas.ts";
import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import { newShareCode } from "../ids.ts";
import type { PlanRepo } from "../services/types.ts";
import { readBoundedBody } from "./bounded-body.ts";
import { parsePlanVisibility } from "./plan-visibility.ts";
import { problem } from "./problem.ts";
import { resolveSessionUserId } from "./require-user.ts";
import { hashShareCode } from "./share-auth.ts";

/**
 * The owner's side of sharing: who may read a plan, and the code that lets
 * anyone holding a link read it.
 *
 * Every handler here resolves its caller from a session, never from an API
 * key, and that is deliberate rather than an oversight. A key already grants
 * upload, replacement, delete, and - since the read gate - reading its owner's
 * plans. Letting it also *hand out access to other people* would turn a leaked
 * key from a data-loss problem into a persistent backdoor. Sharing is changed
 * from the dashboard.
 *
 * The check lives inside each handler rather than in the router, so a route
 * registered later cannot forget it.
 *
 * Every "not yours" answers 404, matching the rest of the plan API: never
 * confirm that someone else's id exists.
 */

/** A handle is ten characters; the document carrying one is tiny. */
const MAX_GRANT_BODY_BYTES = 1024;

/** The same, for `{ "visibility": "private" }`. */
const MAX_SHARING_BODY_BYTES = 256;

/** The parsed JSON body, or the response that refuses it. */
async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ body: unknown } | Response> {
  const encoded = await readBoundedBody(request, maxBytes);
  if (encoded === null) return problem(413, `body exceeds ${maxBytes} bytes`);
  try {
    return { body: JSON.parse(new TextDecoder().decode(encoded)) };
  } catch {
    return problem(400, "body must be JSON");
  }
}

/**
 * The whole sharing state in one response, so the dashboard renders a row from
 * a single request and every mutation below can answer with the new state.
 */
async function sharingState(
  plans: PlanRepo,
  planId: string,
  ownerId: string,
): Promise<Response> {
  const grants = await plans.listGrantHandles(planId, ownerId);
  if (grants === null) return problem(404, "not found");

  const row = await plans.findAccess(planId);
  if (row === null) return problem(404, "not found");

  return Response.json(
    {
      visibility: row.visibility,
      hasShareCode: row.shareCodeHash !== null,
      grants,
    } satisfies PlanSharing,
    // Names every account a plan is shared with, so it belongs in no cache.
    // `applySecurityHeaders` sets no cache directive of its own.
    { headers: { "cache-control": "no-store" } },
  );
}

export async function getPlanSharing(
  auth: AppAuth,
  plans: PlanRepo,
  request: Request,
  planId: string,
): Promise<Response> {
  const ownerId = await resolveSessionUserId(auth, request);
  if (ownerId === null) return problem(401, "authentication required");

  return await sharingState(plans, planId, ownerId);
}

export async function setPlanSharing(
  auth: AppAuth,
  plans: PlanRepo,
  request: Request,
  planId: string,
): Promise<Response> {
  const ownerId = await resolveSessionUserId(auth, request);
  if (ownerId === null) return problem(401, "authentication required");

  const read = await readJson(request, MAX_SHARING_BODY_BYTES);
  if (read instanceof Response) return read;

  const { body } = read;
  const wanted = parsePlanVisibility(
    typeof body === "object" && body !== null && "visibility" in body
      ? body.visibility
      : undefined,
  );
  if (!wanted.ok) return problem(400, wanted.reason);

  if (!(await plans.setVisibility(planId, ownerId, wanted.visibility))) {
    return problem(404, "not found");
  }
  return await sharingState(plans, planId, ownerId);
}

/**
 * Mints a fresh code and returns the plaintext. The only response that ever
 * carries it - the column holds a digest, so there is nothing to read back.
 *
 * Rotating revokes every outstanding unlock cookie for free: a cookie binds
 * the digest that was current when it was issued (see src/http/share-auth.ts).
 */
export async function rotateShareCode(
  auth: AppAuth,
  plans: PlanRepo,
  config: Pick<Config, "shareCodeLength">,
  request: Request,
  planId: string,
): Promise<Response> {
  const ownerId = await resolveSessionUserId(auth, request);
  if (ownerId === null) return problem(401, "authentication required");

  const code = newShareCode(config.shareCodeLength);
  const stored = await plans.setShareCodeHash(
    planId,
    ownerId,
    await hashShareCode(code),
  );
  if (!stored) return problem(404, "not found");

  // The one response that ever carries a plaintext code.
  return Response.json({ code } satisfies ShareCodeCreated, {
    status: 201,
    headers: { "cache-control": "no-store" },
  });
}

export async function clearShareCode(
  auth: AppAuth,
  plans: PlanRepo,
  request: Request,
  planId: string,
): Promise<Response> {
  const ownerId = await resolveSessionUserId(auth, request);
  if (ownerId === null) return problem(401, "authentication required");

  if (!(await plans.setShareCodeHash(planId, ownerId, null))) {
    return problem(404, "not found");
  }
  return new Response(null, { status: 204 });
}

/**
 * Grants one account, addressed by handle.
 *
 * Confirming that a handle exists is safe: a handle is ten characters of a
 * 31-symbol alphabet, about 49 bits, so the set cannot be enumerated - and an
 * owner typing a colleague's handle needs to know they got it wrong.
 */
export async function grantPlan(
  auth: AppAuth,
  plans: PlanRepo,
  request: Request,
  planId: string,
): Promise<Response> {
  const ownerId = await resolveSessionUserId(auth, request);
  if (ownerId === null) return problem(401, "authentication required");

  const read = await readJson(request, MAX_GRANT_BODY_BYTES);
  if (read instanceof Response) return read;

  const { body } = read;
  if (typeof body !== "object" || body === null || !("handle" in body)) {
    return problem(400, "handle is required");
  }
  const handle = body.handle;
  if (typeof handle !== "string" || handle.trim() === "") {
    return problem(400, "handle is required");
  }

  switch (await plans.grantByHandle(planId, ownerId, handle.trim())) {
    case "granted":
      return new Response(null, { status: 204 });
    case "no-user":
      return problem(404, "no such account");
    case "no-plan":
      return problem(404, "not found");
  }
}

export async function revokePlanGrant(
  auth: AppAuth,
  plans: PlanRepo,
  request: Request,
  planId: string,
  handle: string,
): Promise<Response> {
  const ownerId = await resolveSessionUserId(auth, request);
  if (ownerId === null) return problem(401, "authentication required");

  if (!(await plans.revokeByHandle(planId, ownerId, handle))) {
    return problem(404, "not found");
  }
  return new Response(null, { status: 204 });
}
