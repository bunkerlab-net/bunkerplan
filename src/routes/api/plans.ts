import { createFileRoute } from "@tanstack/react-router";
import { getServices } from "#runtime";
import { parsePlanLabel } from "../../http/plan-label.ts";
import { planUrl } from "../../http/plan-url.ts";
import {
  resolveSessionUserId,
  resolveWriteUserId,
} from "../../http/require-user.ts";
import { readUploadBody } from "../../http/upload-body.ts";
import { checkUploadRate } from "../../http/upload-rate-limit.ts";
import { newPlanId } from "../../ids.ts";
import type { PlanRepo } from "../../services/types.ts";

const MAX_ID_ATTEMPTS = 3;

function problem(status: number, error: string, headers?: HeadersInit) {
  return Response.json({ error }, { status, ...(headers ? { headers } : {}) });
}

/**
 * Claims a free id, retrying only a collision. A full account is refused by
 * the same statement and must not be retried into.
 */
async function claimId(
  plans: PlanRepo,
  userId: string,
  label: string | null,
  size: number,
  length: number,
  maxPlans: number,
): Promise<string | "quota" | null> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = newPlanId(length);
    const claimed = await plans.insert({ id, userId, label, size }, maxPlans);
    if (claimed === "created") return id;
    if (claimed === "quota") return "quota";
  }
  return null;
}

async function createPlan(request: Request): Promise<Response> {
  const { auth, config, db, logger, storage } = await getServices();

  const userId = await resolveWriteUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  const limited = await checkUploadRate(db.uploadRateLimits, config, userId);
  if (limited !== null) return limited;

  // A label is optional metadata, so a bad one is rejected before the body is
  // read rather than after a large upload has already been accepted.
  const parsed = parsePlanLabel(new URL(request.url).searchParams.get("label"));
  if (!parsed.ok) return problem(400, parsed.reason);

  const body = await readUploadBody(request, config.maxUploadBytes);
  if (body instanceof Response) return body;

  // Row first, object second. The public GET never consults the database, so an
  // object with no row would be served forever with no owner and no way to
  // delete it. A row with no object is merely a 404 its owner can clean up.
  const id = await claimId(
    db.plans,
    userId,
    parsed.label,
    body.byteLength,
    config.planIdLength,
    config.maxPlansPerUser,
  );
  if (id === "quota") {
    return problem(
      409,
      `plan limit reached (${config.maxPlansPerUser}); delete one first`,
    );
  }
  if (id === null) return problem(500, "could not allocate a plan id");

  try {
    await storage.put(id, body);
  } catch (error) {
    await db.plans.deleteOwned(id, userId);
    logger.error({ err: error, planId: id }, "plan upload failed");
    return problem(502, "storage unavailable");
  }

  const url = planUrl(config.publicBaseUrl, id);
  return Response.json(
    { id, url, label: parsed.label },
    { status: 201, headers: { location: url } },
  );
}

async function listPlans(request: Request): Promise<Response> {
  const { auth, config, db } = await getServices();
  // Session-only: an API key authorises writes to plans, nothing else.
  const userId = await resolveSessionUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  // The quota caps how many rows can exist, so this returns every plan the
  // account has; the limit is a ceiling on the response, not pagination.
  const rows = await db.plans.listByUser(userId, config.maxPlansPerUser);
  return Response.json({
    plans: rows.map((row) => ({
      id: row.id,
      url: planUrl(config.publicBaseUrl, row.id),
      label: row.label,
      size: row.size,
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

export const Route = createFileRoute("/api/plans")({
  server: {
    handlers: {
      PUT: ({ request }) => createPlan(request),
      GET: ({ request }) => listPlans(request),
    },
  },
});
