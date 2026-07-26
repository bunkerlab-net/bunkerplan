import type { PlanRepo } from "../services/types.ts";
import { readBoundedBody } from "./bounded-body.ts";
import { parsePlanLabel } from "./plan-label.ts";

/**
 * A label is capped at 100 characters, so the document carrying one has no
 * business being large. Without a bound this endpoint parses whatever it is
 * sent before the cap is ever consulted, and it is not rate limited.
 */
const MAX_LABEL_BODY_BYTES = 4096;

/**
 * Relabels a plan the caller owns. Nothing outside the row changes: the object
 * key, the public URL, and the served document are all untouched.
 *
 * `relabel` re-checks ownership in its own predicate, so no separate lookup is
 * needed and there is no window in which another account's row could match.
 * A miss is a 404 rather than a 403 - never confirm that someone else's id
 * exists.
 */
export async function relabelPlan(
  plans: PlanRepo,
  request: Request,
  id: string,
  userId: string,
): Promise<Response> {
  const encoded = await readBoundedBody(request, MAX_LABEL_BODY_BYTES);
  if (encoded === null) {
    return Response.json(
      { error: `body exceeds ${MAX_LABEL_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || !("label" in body)) {
    return Response.json({ error: "label is required" }, { status: 400 });
  }

  const raw = body.label;
  if (raw !== null && typeof raw !== "string") {
    return Response.json(
      { error: "label must be a string or null" },
      { status: 400 },
    );
  }

  const parsed = parsePlanLabel(raw);
  if (!parsed.ok) {
    return Response.json({ error: parsed.reason }, { status: 400 });
  }

  if (!(await plans.relabel(id, userId, parsed.label))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return Response.json({ id, label: parsed.label });
}
