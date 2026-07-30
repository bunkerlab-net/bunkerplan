import type { Health } from "../api/schemas.ts";
import type { RuntimeTarget, Services } from "../services/types.ts";

/** The probe reads no configuration, so it takes only what it exercises. */
export type Probed = Pick<Services, "storage" | "db" | "kv" | "logger">;

const CHECKS = ["storage", "db", "kv"] as const;

/**
 * A probe that never returns is worse than one that fails: the endpoint is
 * unauthenticated, and the S3 client ships no request timeout of its own, so a
 * blackholed endpoint would pin a socket and a pool client per call until both
 * ran out.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Docker polls every 30s, so a short cache changes nothing an operator sees
 * while turning a flood of anonymous calls into one round of backend work.
 */
const CACHE_MS = 5_000;

/**
 * Keyed on the services object rather than held in a bare module variable, so
 * the cache belongs to one wiring. In production `getServices` is memoised and
 * there is exactly one, which is the intended behaviour; a test that builds
 * its own fakes gets its own entry instead of inheriting the previous one.
 */
const cache = new WeakMap<Probed, { at: number; response: () => Response }>();

/**
 * Bounds the probe and then cancels it.
 *
 * A bare `Promise.race` settles the response and leaves the request running,
 * which is the half that does not release the socket the deadline exists for.
 * The signal is what carries the deadline to the driver; one whose client API
 * cannot take it keeps the old behaviour rather than blocking the rest.
 */
async function withTimeout(
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(controller.signal),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          const expired = new Error(
            `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
          );
          controller.abort(expired);
          reject(expired);
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    // Only the timer. Aborting here as well would be dead: the race has
    // settled, so the probe has either answered already or been aborted by the
    // deadline in the race above.
    clearTimeout(timer);
  }
}

/**
 * `/healthz` is a self-hosting feature. Its only caller is the Dockerfile
 * HEALTHCHECK, which needs an unauthenticated readiness signal because a
 * container orchestrator has no other way to see that Postgres, Valkey, and the
 * S3 endpoint are reachable from inside the container.
 *
 * On Workers it is a liability instead. Nothing polls it - Cloudflare reports
 * Worker health itself - while every call fans one unauthenticated public
 * request out into three billable backend operations: a D1 query, a KV read,
 * and an R2 head. That is an amplifier anyone holding the URL can point at the
 * account's bill, so the route refuses outright with a plain `404`.
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

  const probed = await services();
  const { storage, db, kv, logger } = probed;

  const now = Date.now();
  const previous = cache.get(probed);
  if (previous !== undefined && now - previous.at < CACHE_MS) {
    return previous.response();
  }

  const settled = await Promise.allSettled([
    withTimeout((signal) => storage.probe(signal)),
    withTimeout((signal) => db.probe(signal)),
    withTimeout((signal) => kv.probe(signal)),
  ]);

  const checks: Health["checks"] = {};
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

  const status = ok ? 200 : 503;
  const body: Health = { status: ok ? "ok" : "error", checks };
  // Stored as a factory: a `Response` body can only be read once.
  const response = () => Response.json(body, { status });
  cache.set(probed, { at: now, response });
  return response();
}
