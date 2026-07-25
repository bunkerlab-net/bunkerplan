import { authClient } from "./auth.ts";

interface NavProps {
  handle: string | null;
  busy: boolean;
  onSignIn: () => void;
}

export function SiteNav({ handle, busy, onSignIn }: NavProps) {
  return (
    <nav className="nav">
      <div className="shell nav-inner">
        <a className="wordmark" href="/">
          BunkerPlan
        </a>
        <div className="nav-right">
          {handle === null ? (
            <button
              type="button"
              className="btn-text"
              disabled={busy}
              onClick={onSignIn}
            >
              Sign in
            </button>
          ) : (
            <>
              <span className="nav-handle">{handle}</span>
              <button
                type="button"
                className="btn-text"
                onClick={() =>
                  void authClient()
                    .signOut()
                    .then(() => window.location.reload())
                }
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </div>
    </nav>
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
              One standalone HTML document in, one public URL out. Passkeys
              only.
            </p>
          </div>
          <div>
            <h2>API</h2>
            <ul>
              <li className="mono">PUT /api/plans</li>
              <li className="mono">DELETE /api/plans/:id</li>
              <li className="mono">GET /:id</li>
            </ul>
          </div>
          <div>
            <h2>Service</h2>
            <ul>
              <li>
                <a href="/healthz">Health check</a>
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
