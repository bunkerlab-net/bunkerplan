import { createFileRoute } from "@tanstack/react-router";
import { getServices } from "#runtime";
import { validateStandaloneHtml } from "../../html/validate.ts";
import { planUrl } from "../../http/plan-url.ts";
import { checkRateLimit } from "../../http/rate-limit.ts";
import {
  resolveSessionUserId,
  resolveWriteUserId,
} from "../../http/require-user.ts";
import { newPlanId } from "../../ids.ts";
import type { PlanRepo } from "../../services/types.ts";

const MAX_ID_ATTEMPTS = 3;

function problem(status: number, error: string, headers?: HeadersInit) {
  return Response.json({ error }, { status, ...(headers ? { headers } : {}) });
}

/** Claims a free id by inserting the row first — see the ordering note below. */
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

/**
 * Reads and vets the request body, or returns the failing response. The
 * Content-Length check rejects an oversized upload before reading it.
 */
async function readUploadBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "text/html") {
    return problem(415, "content-type must be text/html");
  }

  const tooBig = `upload exceeds ${maxBytes} bytes`;
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return problem(413, tooBig);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) return problem(413, tooBig);

  const validation = validateStandaloneHtml(bytes);
  if (!validation.ok) return problem(422, validation.reason);

  return bytes;
}

async function createPlan(request: Request): Promise<Response> {
  const { auth, config, db, kv, logger, storage } = await getServices();

  const userId = await resolveWriteUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  const limit = await checkRateLimit(
    kv,
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
