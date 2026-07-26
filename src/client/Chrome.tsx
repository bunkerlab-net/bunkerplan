import type { Child } from "hono/jsx";
import { authClient } from "./auth.ts";

interface NavProps {
  /** `null` while a session is still resolving as well as when signed out. */
  handle?: string | null;
  busy?: boolean;
  /**
   * Omitted on pages rendered without an auth context, such as the 404 served
   * from the plan path. The nav then carries the wordmark alone, which is
   * better than a sign-in button that cannot run a ceremony.
   */
  onSignIn?: () => void;
  /**
   * The request path, threaded from the server render rather than read from a
   * router. Two pages do not need a router, and passing it keeps the server
   * and client first renders identical.
   */
  path?: string;
}

function NavControls({
  handle = null,
  busy = false,
  onSignIn,
  path = "/",
}: NavProps) {
  // Dropped on the dashboard itself, where it would point at this page.
  const onDashboard = path === "/dashboard";

  if (handle !== null) {
    return (
      <div className="nav-right">
        {!onDashboard && (
          <a className="btn-text" href="/dashboard">
            Dashboard
          </a>
        )}
        <span className="nav-handle">{handle}</span>
        <button
          type="button"
          className="btn-text"
          onClick={() =>
            void authClient()
              .signOut()
              // Leaves the dashboard rather than reloading it: signed out, the
              // guard there would only bounce the visitor here anyway.
              .then(() => window.location.assign("/"))
          }
        >
          Sign out
        </button>
      </div>
    );
  }

  if (onSignIn === undefined) return null;

  return (
    <div className="nav-right">
      <button
        type="button"
        className="btn-text"
        disabled={busy}
        onClick={onSignIn}
      >
        Sign in
      </button>
    </div>
  );
}

export function SiteNav(props: NavProps) {
  return (
    <nav className="nav">
      <div className="shell nav-inner">
        <a className="wordmark" href="/">
          BunkerPlan
        </a>
        <NavControls {...props} />
      </div>
    </nav>
  );
}

/**
 * The frame every page wears. Kept beside the nav and footer it composes, so a
 * page only has to say what belongs in `main`.
 */
export function SiteFrame({
  children,
  ...nav
}: NavProps & { children: Child }) {
  return (
    <div className="page">
      <SiteNav {...nav} />
      <main id="main">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer-grid">
          <div>
            <h2>BunkerPlan</h2>
            <p className="caption">
              Upload a self-contained HTML page and share the URL. Built for the
              plans, reviews, and diagrams your LLM renders.
            </p>
          </div>
          <div>
            <h2>API</h2>
            <ul>
              <li className="mono">PUT /api/plans</li>
              <li className="mono">PUT /api/plans/:id</li>
              <li className="mono">DELETE /api/plans/:id</li>
              <li className="mono">GET /p/:id</li>
            </ul>
          </div>
          <div>
            <h2>Source</h2>
            <ul>
              <li>
                <a href="/api/docs">API reference</a>
              </li>
              <li>
                <a href="https://github.com/bunkerlab-net/bunkerplan">GitHub</a>
              </li>
            </ul>
          </div>
        </div>
        <p className="footer-bottom caption">
          Plans are public to anyone holding the URL and unlisted otherwise.
        </p>
      </div>
    </footer>
  );
}
