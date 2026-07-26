import { createFileRoute } from "@tanstack/react-router";
import { getServices } from "#runtime";
import { planUrl } from "../../http/plan-url.ts";
import {
  resolveSessionUserId,
  resolveWriteUserId,
} from "../../http/require-user.ts";
import { readUploadBody } from "../../http/upload-body.ts";
import { newPlanId } from "../../ids.ts";
import type { PlanRepo } from "../../services/types.ts";

const MAX_ID_ATTEMPTS = 3;

function problem(status: number, error: string, headers?: HeadersInit) {
  return Response.json({ error }, { status, ...(headers ? { headers } : {}) });
}

/** Claims a free id by inserting the row first - see the ordering note below. */
async function claimId(
  plans: PlanRepo,
  userId: string,
  size: number,
  length: number,
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = newPlanId(length);
    if (await plans.insert({ id, userId, size })) return id;
  }
  return null;
}

async function createPlan(request: Request): Promise<Response> {
  const { auth, config, db, logger, storage } = await getServices();

  const userId = await resolveWriteUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  // Per user, not per credential: an API key and the dashboard session share
  // one allowance, and creating more keys does not buy more uploads.
  const limit = await db.uploadRateLimits.consume(
    userId,
    config.uploadRateMax,
    config.uploadRateWindowSec,
  );
  if (!limit.allowed) {
    return problem(429, "rate limit exceeded", {
      "retry-after": String(limit.retryAfter),
    });
  }

  const body = await readUploadBody(request, config.maxUploadBytes);
  if (body instanceof Response) return body;

  // Row first, object second. The public GET never consults the database, so an
  // object with no row would be served forever with no owner and no way to
  // delete it. A row with no object is merely a 404 its owner can clean up.
  const id = await claimId(
    db.plans,
    userId,
    body.byteLength,
    config.planIdLength,
  );
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
    { id, url },
    { status: 201, headers: { location: url } },
  );
}

async function listPlans(request: Request): Promise<Response> {
  const { auth, config, db } = await getServices();
  // Session-only: an API key authorises upload and delete, nothing else.
  const userId = await resolveSessionUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  const rows = await db.plans.listByUser(userId);
  return Response.json({
    plans: rows.map((row) => ({
      id: row.id,
      url: planUrl(config.publicBaseUrl, row.id),
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
