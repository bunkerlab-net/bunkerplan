import { useState } from "hono/jsx";
import { MAX_SHARE_CODE_LENGTH } from "../config.ts";
import { unlockPlan } from "./api.ts";
import { useSession } from "./auth.ts";
import { SiteFrame } from "./Chrome.tsx";
import { inputOf } from "./dom.ts";
import type { GateProps } from "./pages.tsx";
import { usePasskeyAction } from "./passkey.ts";

/** One gate per page, so a constant id is unambiguous. */
const ERROR_ID = "share-code-error";

/**
 * What a visitor sees when a plan exists but they are not allowed it yet.
 *
 * Served at 401, not 200, and that is load-bearing: the plan CSP is pinned
 * onto `/p/*` responses at 200 and 304, and under it this page could neither
 * sign in nor submit a code. See src/http/security-headers.ts.
 *
 * There are only two ways through, so those are the only two controls: a share
 * code, and the account that owns or was granted the plan.
 */
export function PlanGate({ planId, hasCode, path }: GateProps) {
  const { data: session, isPending } = useSession();
  // Back to the plan on success, not the dashboard - the plan is what they
  // came for.
  const passkey = usePasskeyAction(`/p/${planId}`);
  const handle = session?.user.name ?? null;

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: Event) => {
    event.preventDefault();
    if (busy || code === "") return;
    setBusy(true);
    // The previous attempt's message must go now, or a second try appears to
    // have failed the moment it starts.
    setError(null);
    void (async () => {
      try {
        await unlockPlan(planId, code);
        // A full reload rather than a fetch of the document: the unlock
        // response set the cookie, so the plan is now simply a normal
        // navigation - and it must be, because the plan renders under its own
        // sandboxed CSP.
        window.location.reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      }
    })();
  };

  return (
    <SiteFrame
      handle={handle}
      path={path}
      busy={isPending || passkey.busy}
      onSignIn={passkey.signIn}
    >
      <div className="shell">
        <div className="hero">
          <h1 className="page-title">This plan is private.</h1>
          <p className="lede muted">
            Its owner shares it with a code, or with named accounts. Nothing
            about the document itself is revealed here.
          </p>
        </div>

        {/* One featured card, the way the landing page frames its own sign-in:
            this is the only thing on the page worth acting on. */}
        <section className="card card-feature">
          {hasCode && (
            <>
              <p className="eyebrow">Have a code?</p>
              <form className="row" onSubmit={submit}>
                <input
                  type="text"
                  autoComplete="off"
                  spellcheck={false}
                  placeholder="Share code"
                  aria-label="Share code"
                  aria-describedby={error === null ? undefined : ERROR_ID}
                  maxLength={MAX_SHARE_CODE_LENGTH}
                  value={code}
                  disabled={busy}
                  onChange={(event: Event) => setCode(inputOf(event).value)}
                />
                <button
                  type="submit"
                  className="btn-clay"
                  disabled={busy || code === ""}
                >
                  Unlock
                </button>
              </form>
              {/* A wrong code is the expected outcome here, so the message has
                  to reach a screen reader rather than only the page. */}
              {error !== null && (
                <p className="error" id={ERROR_ID} role="alert">
                  {error}
                </p>
              )}
            </>
          )}

          {handle === null ? (
            <div style={hasCode ? { marginTop: "32px" } : undefined}>
              <p className="eyebrow">{hasCode ? "Or sign in" : "Sign in"}</p>
              <p>
                If this plan was shared with your account, signing in is all it
                takes.
              </p>
              <div className="row" style={{ marginTop: "16px" }}>
                {/* Clay is the single CTA on a page. With no code box there is
                    only one way in, so it takes the accent; with one, the code
                    is the primary path and this steps back to a text action. */}
                <button
                  type="button"
                  className={hasCode ? "btn-text" : "btn-clay"}
                  disabled={isPending || passkey.busy}
                  onClick={passkey.signIn}
                >
                  Sign in with passkey
                </button>
              </div>
              {passkey.error !== null && (
                <p className="error">{passkey.error}</p>
              )}
            </div>
          ) : (
            <div style={hasCode ? { marginTop: "32px" } : undefined}>
              <p className="eyebrow">Signed in as {handle}</p>
              <p>
                This account does not have access to this plan. Ask its owner to
                share it with <span className="mono">{handle}</span>.
              </p>
            </div>
          )}
        </section>
      </div>
    </SiteFrame>
  );
}
