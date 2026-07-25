import type { RuntimeTarget, Services } from "../services/types.ts";

/** The probe reads no configuration, so it takes only what it exercises. */
type Probed = Pick<Services, "storage" | "db" | "kv" | "logger">;

const CHECKS = ["storage", "db", "kv"] as const;

/**
 * `/healthz` is a self-hosting feature. Its only caller is the Dockerfile
 * HEALTHCHECK, which needs an unauthenticated readiness signal because a
 * container orchestrator has no other way to see that Postgres, Valkey and the
 * S3 endpoint are reachable from inside the container.
 *
 * On Workers it is a liability instead. Nothing polls it — Cloudflare reports
 * Worker health itself — while every call fans one unauthenticated public
 * request out into three billable backend operations: a D1 query, a KV read and
 * an R2 head. That is an amplifier anyone holding the URL can point at the
 * account's bill, so the route refuses outright and reports the same 404 as any
 * other path that does not exist.
 *
 * `services` is a getter rather than a value so the refusal returns before any
 * service lookup, not merely before the probes.
 */
export async function healthz(
  target: RuntimeTarget,
  services: () => Promise<Probed>,
): Promise<Response> {
  if (target === "cloudflare") {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const { storage, db, kv, logger } = await services();
  const settled = await Promise.allSettled([
    storage.probe(),
    db.probe(),
    kv.probe(),
  ]);

  const checks: Record<string, string> = {};
  let ok = true;
  for (const [index, name] of CHECKS.entries()) {
    const result = settled[index];
    if (result?.status === "fulfilled") {
      checks[name] = "ok";
      continue;
    }
    ok = false;
    checks[name] = "error";
    // The reason goes to the log and never into the response body: a driver
    // error can embed the connection string, and /healthz is unauthenticated.
    // Logs are the operator's own trust boundary and the only place a 503 can
    // actually be diagnosed, so the full error belongs there.
    logger.error({ err: result?.reason, check: name }, "probe failed");
  }

  return Response.json(
    { status: ok ? "ok" : "error", checks },
    { status: ok ? 200 : 503 },
  );
}
