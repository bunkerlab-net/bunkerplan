import { Hono } from "hono";
import { DOCS_PAGE } from "./api/docs-page.ts";
import { openApiDocument } from "./api/openapi.ts";
import { createPlan } from "./http/create-plan.ts";
import { deletePlan } from "./http/delete-plan.ts";
import { healthz } from "./http/healthz.ts";
import { listPlans } from "./http/list-plans.ts";
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
import { applySecurityHeaders } from "./http/security-headers.ts";
import { servePlan } from "./http/serve-plan.ts";
import { createUnlockRoute } from "./http/unlock.ts";
import { isPlanId } from "./ids.ts";
import type { AssetManifest } from "./server/assets.ts";
import {
  renderDashboard,
  renderLanding,
  renderNotFound,
  renderPlanGate,
} from "./server/pages.tsx";
import type { Services } from "./services/context.ts";
import type { RuntimeTarget } from "./services/types.ts";

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
  // another account 404s and its object is never touched. It resolves its own
  // caller and spends its own upload allowance - see src/http/replace-plan.ts.
  app.put("/api/plans/:id", async (c) => {
    const { auth, config, db, logger, storage } = await getServices();
    return await replacePlan(
      {
        auth,
        config,
        plans: db.plans,
        uploadRateLimits: db.uploadRateLimits,
        storage,
        accountClosing: db.accountClosing,
        logger,
      },
      c.req.raw,
      c.req.param("id"),
    );
  });

  app.patch("/api/plans/:id", async (c) => {
    const { auth, db } = await getServices();
    return await relabelPlan(auth, db.plans, c.req.raw, c.req.param("id"));
  });

  app.delete("/api/plans/:id", async (c) => {
    const { auth, db, logger, storage } = await getServices();
    return await deletePlan(
      { auth, storage, plans: db.plans, logger },
      c.req.raw,
      c.req.param("id"),
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
 * someone holding just a code gets in. The budget arithmetic - reserve before
 * the attempt, refund the one that turned out to be a redemption - lives in
 * src/http/unlock.ts with the reasons for it, so it can be exercised without a
 * server; `createUnlockRoute` is called once here because the closure it
 * returns is what says the missing-header warning once per app.
 */
function registerPlanUnlock(app: Hono, getServices: GetServices): void {
  const unlock = createUnlockRoute();

  app.post("/api/plans/:id/unlock", async (c) => {
    const { config, db, logger } = await getServices();
    return await unlock(
      {
        plans: db.plans,
        limits: db.unlockRateLimits,
        config,
        logger,
      },
      c.req.raw,
      c.req.param("id"),
    );
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
    //
    // Not a decision about access, and deliberately not branched on
    // `row.visibility`: this page renders the same for every reader, and the
    // client forwards to `/p/{id}` whenever there is nothing to spend - a
    // public plan, a revoked code, a bare visit. `/p/{id}` is what knows.
    // Branching here would be the authorisation branch the note above says
    // this route does not have, on the one page that may hold a fragment.
    //
    // No `X-Robots-Tag`: `renderPlanGate` omits `social`, which is what makes
    // `Document` emit `<meta name="robots" content="noindex">` - the gate is
    // the page being served here, so a crawler reading it reads that. Pinned
    // by tests/server-pages.test.ts.
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
    // 401 rather than 200: the gate is the app's own page, answering "you are
    // not allowed this yet". It cannot be swept into the plan sandbox by
    // mistake - `applySecurityHeaders` sandboxes only responses carrying
    // `PLAN_DOCUMENT_HEADER`, which `servePlan` sets on the document itself
    // and nothing else sets.
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
