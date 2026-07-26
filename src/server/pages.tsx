import type { Child } from "hono/jsx";
import { SiteFrame } from "../client/Chrome.tsx";
import { PAGE_PROPS_ID, ROOT_ID } from "../client/mount.ts";
import { NotFound } from "../client/NotFound.tsx";
import type { PageProps } from "../client/pages.tsx";
import { DashboardPage, LandingPage } from "../client/pages.tsx";
import type { AssetManifest } from "./assets.ts";

const TITLE = "BunkerPlan";
const DESCRIPTION =
  "Share the plans, reviews, and diagrams your LLM renders in HTML as a link that opens, not a file that downloads.";
/** Crawlers cache by URL, so the filename is bumped when the artwork changes. */
const OG_IMAGE = "/og-v2.png";
const IMAGE_ALT = "BunkerPlan - upload one HTML file, get a URL that opens.";

interface DocumentProps {
  assets: AssetManifest;
  /** Absent on the 404, which carries `noindex` and no social tags instead. */
  social?: { origin: string; path: string };
  /** Serialised into the document so the client hydrates the same tree. */
  page: PageProps | null;
  children: Child;
}

/**
 * Open Graph requires absolute URLs and crawlers do not run JavaScript, so
 * these have to be resolved while rendering rather than read from `window`.
 */
function SocialTags({ origin, path }: { origin: string; path: string }) {
  const url = new URL(path, origin).href;
  const image = new URL(OG_IMAGE, origin).href;
  return (
    <>
      <meta name="description" content={DESCRIPTION} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={TITLE} />
      <meta property="og:title" content={TITLE} />
      <meta property="og:description" content={DESCRIPTION} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={image} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={IMAGE_ALT} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={TITLE} />
      <meta name="twitter:description" content={DESCRIPTION} />
      <meta name="twitter:image" content={image} />
      <meta name="twitter:image:alt" content={IMAGE_ALT} />
    </>
  );
}

function Document({ assets, social, page, children }: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{TITLE}</title>
        {social ? (
          <SocialTags origin={social.origin} path={social.path} />
        ) : (
          <meta name="robots" content="noindex" />
        )}
        <link rel="stylesheet" href={assets.stylesheet} />
        {/* SVG first: browsers that understand it get a mark that stays sharp
            at any tab density; the PNG is the fallback for those that do not. */}
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link
          rel="icon"
          href="/favicon-32.png"
          type="image/png"
          sizes="32x32"
        />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div id={ROOT_ID}>{children}</div>
        {page !== null && (
          <script
            type="application/json"
            id={PAGE_PROPS_ID}
            // Server-authored constants only - an origin from configuration
            // and a path Hono already matched. `<` is escaped so a value can
            // never close the script element.
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(page).replaceAll("<", "\\u003c"),
            }}
          />
        )}
        <script type="module" src={assets.script} />
      </body>
    </html>
  );
}

function document(node: Child): string {
  return `<!doctype html>${String(node)}`;
}

export function renderLanding(
  assets: AssetManifest,
  path: string,
  origin: string,
): string {
  const page: PageProps = { name: "landing", path, origin };
  return document(
    <Document assets={assets} social={{ origin, path }} page={page}>
      <LandingPage {...page} />
    </Document>,
  );
}

export function renderDashboard(
  assets: AssetManifest,
  path: string,
  origin: string,
): string {
  const page: PageProps = { name: "dashboard", path, origin };
  return document(
    <Document assets={assets} social={{ origin, path }} page={page}>
      <DashboardPage {...page} />
    </Document>,
  );
}

/**
 * Static, and deliberately not hydrated: there is nothing on it to interact
 * with, and it is what `/p/{unknown}` falls through to, so it must not depend
 * on configuration the plan path never loaded.
 */
export function renderNotFound(assets: AssetManifest): string {
  return document(
    <Document assets={assets} page={null}>
      <SiteFrame>
        <NotFound />
      </SiteFrame>
    </Document>,
  );
}
