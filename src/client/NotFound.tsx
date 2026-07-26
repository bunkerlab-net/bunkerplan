import { SiteFrame } from "./Chrome.tsx";

/**
 * Rendered for an unknown app route and for a plan id that is not in storage —
 * a URL whose plan was deleted is the 404 real visitors are most likely to
 * meet, so it gets the site's own chrome rather than the router's bare default.
 *
 * The nav here carries no sign-in control: this page is served without an auth
 * context on the plan path, and a dead button is worse than none.
 */
export function NotFound() {
  return (
    <SiteFrame>
      <div className="shell">
        <div className="hero">
          <h1 className="page-title">Nothing lives at this URL.</h1>
          <p className="lede muted">
            A plan may have been deleted by its owner, or the address may be
            mistyped. Plans are unlisted, so there is nothing to browse from
            here — <a href="/">start from the home page</a> to publish one of
            your own.
          </p>
        </div>
      </div>
    </SiteFrame>
  );
}
