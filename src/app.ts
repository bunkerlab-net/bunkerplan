import { Hono } from "hono";
import { DOCS_PAGE } from "./api/docs-page.ts";
import { openApiDocument } from "./api/openapi.ts";
import { createPlan } from "./http/create-plan.ts";
import { deletePlan } from "./http/delete-plan.ts";
import { healthz } from "./http/healthz.ts";
import { listPlans } from "./http/list-plans.ts";
import { unlockPlan } from "./http/plan-access.ts";
import {
  clearShareCode,
  getPlanSharing,
  grantPlan,
  revokePlanGrant,
  rotateShareCode,
  setPlanSharing,
} from "./http/plan-sharing.ts";
import { problem } from "./http/problem.ts";
import { relabelPlan } from "./http/relabel-plan.ts";
import { replacePlan } from "./http/replace-plan.ts";
import { resolveSessionUserId, resolveUserId } from "./http/require-user.ts";
import { applySecurityHeaders } from "./http/security-headers.ts";
import { servePlan } from "./http/serve-plan.ts";
import {
  refundUnlockAttempt,
  reserveUnlockAttempt,
} from "./http/unlock-rate-limit.ts";
import { checkUploadRate } from "./http/upload-rate-limit.ts";
import { isPlanId } from "./ids.ts";
import type { AssetManifest } from "./server/assets.ts";
import {
  renderDashboard,
  renderLanding,
  renderNotFound,
  renderPlanGate,
} from "./server/pages.tsx";
import type { RuntimeTarget, Services } from "./services/types.ts";

export interface AppDeps {
  /** Memoised by both runtime modules, so this costs one await after boot. */
  getServices: () => Promise<Services>;
  runtime: RuntimeTarget;
  assets: AssetManifest;
}

type GetServices = AppDeps["getServices"];

/** The whole collection: upload a new plan, list the ones you own. */
function registerPlanCollection(app: Hono, getServices: GetServices): void {
  app.put("/api/plans", async (c) => {
    const { auth, config, db, logger, storage } = await getServices();
    return await createPlan(
      {
        auth,
        config,
        plans: db.plans,
        accountClosing: db.accountClosing,
        uploadRateLimits: db.uploadRateLimits,
        storage,
        logger,
      },
      c.req.raw,
    );
  });

  app.get("/api/plans", async (c) => {
    const { auth, config, db } = await getServices();
    return await listPlans(auth, db.plans, config, c.req.raw);
  });
}

/** One plan by id: replace its document, rename it, remove it. */
function registerPlanItem(app: Hono, getServices: GetServices): void {
  // Replaces the document behind an id the caller already owns, so a plan can
  // be revised without its URL changing. Owner-scoped: an id belonging to
  // another account 404s and its object is never touched.
  app.put("/api/plans/:id", async (c) => {
    const { auth, config, db, logger, storage } = await getServices();

    const userId = await resolveUserId(auth, c.req.raw);
    if (userId === null) return problem(401, "authentication required");

    const limited = await checkUploadRate(db.uploadRateLimits, config, userId);
    if (limited !== null) return limited;

    return await replacePlan(
      storage,
      db.plans,
      logger,
      c.req.raw,
      c.req.param("id"),
      userId,
      config,
    );
  });

  // Session-only, unlike PUT and DELETE: an API key authorises upload and
  // delete, and the label it can set is the one it supplies on upload.
  app.patch("/api/plans/:id", async (c) => {
    const { auth, db } = await getServices();

    const userId = await resolveSessionUserId(auth, c.req.raw);
    if (userId === null) return problem(401, "authentication required");

    return await relabelPlan(db.plans, c.req.raw, c.req.param("id"), userId);
  });

  app.delete("/api/plans/:id", async (c) => {
    const { auth, db, logger, storage } = await getServices();

    const userId = await resolveUserId(auth, c.req.raw);
    if (userId === null) return problem(401, "authentication required");

    return await deletePlan(
      storage,
      db.plans,
      logger,
      c.req.param("id"),
      userId,
    );
  });
}

/**
 * Who may read one plan.
 *
 * Under `/api/`, not `/p/`, so the gate page's fetch is governed by the app
 * policy rather than the plan sandbox. Each handler resolves its own session;
 * see src/http/plan-sharing.ts for why a key is not accepted here.
 */
function registerPlanSharing(app: Hono, getServices: GetServices): void {
  app.get("/api/plans/:id/sharing", async (c) => {
    const { auth, db } = await getServices();
    return await getPlanSharing(auth, db.plans, c.req.raw, c.req.param("id"));
  });

  app.put("/api/plans/:id/sharing", async (c) => {
    const { auth, db } = await getServices();
    return await setPlanSharing(auth, db.plans, c.req.raw, c.req.param("id"));
  });

  app.post("/api/plans/:id/share-code", async (c) => {
    const { auth, config, db } = await getServices();
    return await rotateShareCode(
      auth,
      db.plans,
      config,
      c.req.raw,
      c.req.param("id"),
    );
  });

  app.delete("/api/plans/:id/share-code", async (c) => {
    const { auth, db } = await getServices();
    return await clearShareCode(auth, db.plans, c.req.raw, c.req.param("id"));
  });

  app.post("/api/plans/:id/grants", async (c) => {
    const { auth, db, logger } = await getServices();
    return await grantPlan(
      auth,
      db.plans,
      c.req.raw,
      c.req.param("id"),
      logger,
    );
  });

  app.delete("/api/plans/:id/grants/:handle", async (c) => {
    const { auth, db } = await getServices();
    return await revokePlanGrant(
      auth,
      db.plans,
      c.req.raw,
      c.req.param("id"),
      c.req.param("handle"),
    );
  });
}

/**
 * Redeeming a share code, which is the one route here that takes no credential.
 *
 * Its own registrar because everything above is session-only: this is how
 * someone holding just a code gets in. Throttled per client address rather than
 * per plan - the plan id travels in the share link, so a per-plan bucket would
 * let anyone holding that link lock the real readers out. Its own counter
 * table, because `upload_rate_limit.key` is a foreign key onto `user.id` and
 * there is no user here.
 *
 * The budget is checked before the attempt and spent only after one that
 * failed. A correct code costs nothing, because what is being rationed is
 * guessing: the share link is opened by everyone it was sent to, and charging
 * those meant a link pasted into one channel locked out the colleagues behind
 * the same egress address. See src/http/unlock-rate-limit.ts.
 */
function registerPlanUnlock(app: Hono, getServices: GetServices): void {
  app.post("/api/plans/:id/unlock", async (c) => {
    const { config, db, logger } = await getServices();
    const reservation = await reserveUnlockAttempt(
      db.unlockRateLimits,
      config,
      c.req.raw,
      logger,
    );
    if ("refused" in reservation) return reservation.refused;

    /*
     * A redemption was never the thing being rationed, so a count that did not
     * buy a guess goes back. Both endings qualify: a `200`, and a throw - the
     * budget rations guessing, and a route that fell over told nobody whether
     * the code was right. A refusal keeps its count, because that is a guess.
     *
     * Swallowed on failure, and only on the refund: the reader has their
     * cookie, or their 500, and losing a refund leaves the budget one lower
     * than it should be - which errs towards refusing rather than towards
     * letting a guesser through.
     */
    const refund = async () => {
      try {
        await refundUnlockAttempt(db.unlockRateLimits, reservation);
      } catch (cause) {
        logger.warn({ err: cause }, "unlock reservation was not refunded");
      }
    };

    let response: Response;
    try {
      response = await unlockPlan(
        db.plans,
        config,
        c.req.raw,
        c.req.param("id"),
      );
    } catch (cause) {
      await refund();
      throw cause;
    }
    if (response.ok) await refund();
    return response;
  });
}

/**
 * Better Auth owns every route under its prefix, and the two documents that
 * describe everything else: the generated spec and the reference that renders
 * it.
 */
function registerAuthAndDocs(app: Hono, getServices: GetServices): void {
  // `auth.handler` returns a Response carrying any Set-Cookie.
  app.all("/api/auth/*", async (c) => {
    const { auth } = await getServices();
    return await auth.handler(c.req.raw);
  });

  app.get("/api/openapi.json", async (c) => {
    const { config } = await getServices();
    return c.json(openApiDocument(config));
  });

  app.get("/api/docs", (c) =>
    c.html(DOCS_PAGE, 200, { "content-type": "text/html; charset=utf-8" }),
  );
}

/**
 * Where a share link points, and the reason it is not `/p/{planId}`.
 *
 * The code travels in the fragment so it reaches no access log, no proxy and no
 * `Referer` - but `/p/{planId}` answers an authorised reader with the uploaded
 * document, and that document is untrusted HTML which can read its own
 * `location.hash`. This page is the app's own, under the app policy because the
 * prefix is not `/p/`: it spends the code and then sends the reader to the plan,
 * so the credential is never handed to a document the reader did not write.
 *
 * That policy is load-bearing rather than incidental - the page has to hydrate
 * to redeem anything - so tests/app-routes.test.ts pins the headers this path
 * gets, not just its body.
 *
 * Deliberately not gated on access. It reveals exactly what `/p/{planId}`
 * already does - a real id renders a page, an unknown one renders the 404 - and
 * it cannot consult the fragment to decide anything, because the server never
 * receives it. That is also what makes it safe: there is no authorisation branch
 * in which a fragment could land on plan HTML instead.
 */
function registerShareRelay(app: Hono, deps: AppDeps): void {
  const { getServices, assets } = deps;

  /*
   * Not rate limited, deliberately. It answers with one indexed lookup by
   * primary key and tells an unknown id from a known one only by rendering the
   * gate rather than the 404 - the same disclosure `/p/{id}` already makes, on
   * the same lookup, also unthrottled. A limiter here would need the trusted
   * address header to key on, which is the one thing a share link's reader may
   * arrive without, and would lock out a link opened by a room of people
   * behind one egress address. What guesses is the unlock route, and that is
   * where the budget is.
   */
  app.get("/s/:planId", async (c) => {
    const { config, db } = await getServices();
    const planId = c.req.param("planId");
    // Only ids this app could have issued reach the store, the same rule
    // `resolvePlanAccess` applies on `/p/{id}`.
    const row = isPlanId(planId) ? await db.plans.findAccess(planId) : null;
    if (row === null) return c.html(renderNotFound(assets), 404);

    // Only whether a code exists. `shareCodeHash` is what would let a holder
    // forge this plan's unlock cookie, so it never reaches a response body.
    return c.html(
      renderPlanGate(assets, planId, config.publicBaseUrl, {
        hasCode: row.shareCodeHash !== null,
        relay: true,
      }),
      200,
      { "cache-control": "no-store" },
    );
  });
}

/**
 * The published plan itself, at the one prefix reserved for it.
 *
 * Its own registration rather than part of the site below: this is the only
 * route that serves a document somebody else uploaded, and the only one whose
 * responses carry the plan sandbox instead of the app policy.
 */
function registerPlanPage(app: Hono, deps: AppDeps): void {
  const { getServices, assets } = deps;

  app.get("/p/:planId", async (c) => {
    const { auth, config, db, storage } = await getServices();
    const planId = c.req.param("planId");
    const served = await servePlan(
      storage,
      db.plans,
      auth,
      config,
      c.req.raw,
      planId,
    );
    // A miss renders the site's own 404 page, which is trusted HTML and takes
    // the app policy rather than the plan one.
    if (served === null) return c.html(renderNotFound(assets), 404);
    // 401 rather than 200 is load-bearing: `applySecurityHeaders` pins the
    // plan sandbox onto `/p/*` only at 200 and 304, and under it this page
    // could neither sign in nor post a code.
    if ("gate" in served) {
      return c.html(
        renderPlanGate(assets, planId, config.publicBaseUrl, {
          hasCode: served.hasCode,
        }),
        401,
        { "cache-control": "no-store" },
      );
    }
    return served;
  });
}

/** The rendered pages, the self-hosting probe, and the catch-all. */
function registerSite(app: Hono, deps: AppDeps): void {
  const { getServices, runtime, assets } = deps;

  // `getServices` is passed uncalled on purpose: on Workers the probe is
  // refused before any binding is touched. See src/http/healthz.ts.
  app.get("/healthz", () => healthz(runtime, getServices));
  // The origin comes from the configured public base URL, not from the
  // request: `Host` is whatever reached the process, so behind a proxy that
  // forwards it unchanged a crawler could be handed tags pointing at someone
  // else's hostname.
  app.get("/", async (c) => {
    const { config } = await getServices();
    return c.html(renderLanding(assets, c.req.path, config.publicBaseUrl));
  });

  app.get("/dashboard", async (c) => {
    const { config } = await getServices();
    return c.html(renderDashboard(assets, c.req.path, config.publicBaseUrl));
  });

  // An unknown path under `/api` answers like the rest of the API rather than
  // handing a client 2 KB of landing-page HTML it cannot parse. Better Auth
  // owns everything under `/api/auth`, so a miss there never reaches this.
  app.notFound((c) => {
    const path = c.req.path;
    return path === "/api" || path.startsWith("/api/")
      ? problem(404, "not found")
      : c.html(renderNotFound(assets), 404);
  });
}

/**
 * Every route this app answers.
 *
 * Handlers stay in src/http/*, which knows nothing about Hono - they are plain
 * `(Request) => Response` functions, which is what lets the unit tests
 * exercise them without a server.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  /**
   * Headers are applied on the way out, from one shared function, so a route
   * that forgets them still cannot reach a client without them.
   *
   * Nothing is resolved on the way in. `/healthz` on Workers MUST refuse
   * before any service lookup - see the note in src/http/healthz.ts - and a
   * middleware that awaited `getServices()` here would construct the auth
   * instance and parse the configuration first, turning a documented plain
   * 404 into whatever `loadConfig` threw.
   */
  app.use(async (c, next) => {
    await next();
    c.res = applySecurityHeaders(c.req.raw, c.res);
  });

  registerAuthAndDocs(app, deps.getServices);
  registerPlanCollection(app, deps.getServices);
  registerPlanItem(app, deps.getServices);
  registerPlanSharing(app, deps.getServices);
  registerPlanUnlock(app, deps.getServices);
  registerShareRelay(app, deps);
  registerPlanPage(app, deps);
  registerSite(app, deps);

  return app;
}
