import { useEffect, useRef, useState } from "hono/jsx";
import { unlockPlan } from "./api.ts";
import { useSession } from "./auth.ts";
import { SiteFrame } from "./Chrome.tsx";
import { inputOf } from "./dom.ts";
import { messageOf } from "./errors.ts";
import type { GateProps } from "./pages.tsx";
import { usePasskeyAction } from "./passkey.ts";

/** One gate per page, so a constant id is unambiguous. */
const ERROR_ID = "share-code-error";

/**
 * `spellcheck="false"`, spread rather than written as a prop.
 *
 * It is an enumerated attribute, not a boolean one, but the JSX types declare
 * it `boolean` - and `hono/jsx/dom` drops a false attribute entirely, so
 * `spellcheck={false}` renders nothing and hydration then *deletes* the
 * server's `spellcheck="false"`. The field would inherit the document's
 * setting and hand a share code to the spell checker, which on several
 * platforms means sending it to a remote service.
 */
const NO_SPELLCHECK: Record<string, string> = { spellcheck: "false" };

/**
 * The share code a link people paste carries.
 *
 * A fragment, because a fragment is never sent to a server: it reaches no
 * access log and no proxy, and cannot end up in the `Referer` of anything this
 * page loads. `?code=` still works and is what a reader without a DOM uses -
 * `curl` cannot send a fragment - so this is the transport for shared links
 * rather than a replacement for the parameter. SECURITY.md records the split.
 *
 * Matched only in the exact shape the dashboard emits. An ordinary `#section`
 * is left alone rather than parsed as parameters, which would rewrite it.
 */
function codeInFragment(hash: string): string | null {
  const match = /^#code=(.+)$/.exec(hash);
  if (match === null) return null;
  try {
    const code = decodeURIComponent(match[1] ?? "");
    return code === "" ? null : code;
  } catch {
    // A malformed escape is not a code. Treated as no fragment at all, so the
    // box is offered instead of an error nobody can act on.
    return null;
  }
}

/**
 * Takes a code out of the fragment on mount and spends it once.
 *
 * A link that brought its own code spends it without asking: the reader already
 * clicked the thing that carried it, so a box pre-filled with the answer and a
 * button to press is a step that means nothing.
 *
 * Out of the address bar first, before anything can fail. A fragment reaches no
 * server and no `Referer`, but it is in this browser's history, and stripping it
 * only after a successful redemption would leave it there for every reader whose
 * code was wrong or whose connection dropped - which is the surface the fragment
 * was chosen to avoid. `replaceState`, so the entry is amended rather than added
 * to. It goes into the box on the way past, so a retry is a button press rather
 * than a hunt for the link.
 *
 * Spent only if the plan has a code to redeem. A link outlives the sharing it
 * was made under - the owner can revoke the code and leave the plan private -
 * and posting a stale one would fail into a form this page does not render for
 * such a plan, so the reader would see nothing happen while the attempt spent
 * from a bucket keyed on their address. Stripped either way: a dead code is
 * still a secret that was.
 *
 * Once, on mount. `redeem` latches, so a re-render cannot spend it twice.
 */
function useLinkCode(
  hasCode: boolean,
  onCode: (code: string) => void,
  redeem: (code: string) => void,
): void {
  useEffect(() => {
    const fromLink = codeInFragment(window.location.hash);
    if (fromLink === null) return;

    onCode(fromLink);
    window.history.replaceState(null, "", window.location.pathname);
    if (hasCode) redeem(fromLink);
  }, []);
}

/** The code box, and the unlock it performs. */
function useUnlock(planId: string, hasCode: boolean) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The same guard as `busy`, but readable in the turn it is set.
   *
   * `busy` is state: the handler closes over the value from the render it was
   * created in, so three Enter presses in one tick all see `false` and all
   * three reach the network. This route is rate-limited per client address and
   * a wrong code is the expected outcome here, so that turns an impatient
   * reader into someone who has locked themselves out.
   *
   * Deliberately released in `catch` rather than in a `finally`: on the success
   * path this page is navigating away, and browsers run that navigation
   * asynchronously. A `finally` would reopen the box while the unlocked
   * document is still loading, which is the second submission the latch exists
   * to prevent. A `replace()` that throws lands in the `catch` like any other
   * failure. One that neither throws nor unloads - an embedding where it is a
   * no-op - does stay latched, which is the same state as a navigation still in
   * progress and the safer of the two readings.
   */
  const inFlight = useRef(false);

  // Codes get copied out of chat clients and mail, which is where a stray
  // space either side comes from. The server compares a digest, so it cannot
  // forgive one.
  const trimmed = code.trim();

  /**
   * One redemption path for both ways in: the box below, and a code the link
   * itself carried. They differ only in where the string came from, and having
   * two copies of the latch and the navigation is how those drift apart.
   */
  const redeem = (value: string) => {
    if (inFlight.current || busy || value === "") return;
    inFlight.current = true;
    setBusy(true);
    // The previous attempt's message must go now, or a second try appears to
    // have failed the moment it starts.
    setError(null);
    void (async () => {
      try {
        await unlockPlan(planId, value);
        // A full navigation rather than a fetch of the document: the unlock
        // response set the cookie, so the plan is now an ordinary request - and
        // it must be one, because the plan renders under its own sandboxed CSP.
        //
        // To the bare path, and replacing this entry rather than adding one: a
        // `?code=` got here in the address bar, and reloading would keep it in
        // history and in the `Referer` of everything the document goes on to
        // load. The cookie is what grants access from here. Taken from
        // `pathname` rather than rebuilt from `planId`, so there is no string to
        // get wrong; the fragment is kept, because by this point it holds no
        // code - the effect below removed that before spending it - and what is
        // left is not secret and may mean something to the document.
        window.location.replace(
          window.location.pathname + window.location.hash,
        );
      } catch (cause) {
        setError(messageOf(cause, "could not unlock the plan"));
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };

  const submit = (event: Event) => {
    event.preventDefault();
    redeem(trimmed);
  };

  useLinkCode(hasCode, setCode, redeem);

  return { code, setCode, submittable: trimmed !== "", error, busy, submit };
}

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
  const { code, setCode, submittable, error, busy, submit } = useUnlock(
    planId,
    hasCode,
  );

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
            <CodeForm
              code={code}
              submittable={submittable}
              error={error}
              busy={busy}
              onCode={setCode}
              onSubmit={submit}
            />
          )}
          <AccountWay
            handle={handle}
            hasCode={hasCode}
            busy={isPending || passkey.busy}
            error={passkey.error}
            onSignIn={passkey.signIn}
          />
        </section>
      </div>
    </SiteFrame>
  );
}

function CodeForm(props: {
  code: string;
  /** Whether the code has anything in it once trimmed. */
  submittable: boolean;
  error: string | null;
  busy: boolean;
  onCode: (value: string) => void;
  onSubmit: (event: Event) => void;
}) {
  return (
    <>
      <p className="eyebrow">Have a code?</p>
      <form className="row" onSubmit={props.onSubmit}>
        {/* No `maxLength`: it counts the whitespace a paste brings with it, so
            a code at the ceiling would have its tail cut off before the trim
            could remove the spaces. The server bounds both the body and the
            code length, which is where it has to hold anyway. */}
        <input
          type="text"
          autoComplete="off"
          {...NO_SPELLCHECK}
          placeholder="Share code"
          aria-label="Share code"
          aria-describedby={props.error === null ? undefined : ERROR_ID}
          value={props.code}
          disabled={props.busy}
          onChange={(event: Event) => props.onCode(inputOf(event).value)}
        />
        <button
          type="submit"
          className="btn-clay"
          disabled={props.busy || !props.submittable}
        >
          Unlock
        </button>
      </form>
      {/* A wrong code is the expected outcome here, so the message has to
          reach a screen reader rather than only the page. */}
      {props.error !== null && (
        <p className="error" id={ERROR_ID} role="alert">
          {props.error}
        </p>
      )}
    </>
  );
}

/** The other way in: the account this plan was shared with. */
function AccountWay(props: {
  handle: string | null;
  hasCode: boolean;
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
}) {
  const spacing = props.hasCode ? { marginTop: "32px" } : undefined;

  if (props.handle !== null) {
    return (
      <div style={spacing}>
        <p className="eyebrow">Signed in as {props.handle}</p>
        <p>
          This account does not have access to this plan. Ask its owner to share
          it with <span className="mono">{props.handle}</span>.
        </p>
      </div>
    );
  }

  return (
    <div style={spacing}>
      <p className="eyebrow">{props.hasCode ? "Or sign in" : "Sign in"}</p>
      <p>
        If this plan was shared with your account, signing in is all it takes.
      </p>
      <div className="row" style={{ marginTop: "16px" }}>
        {/* Clay is the single CTA on a page. With no code box there is only
            one way in, so it takes the accent; with one, the code is the
            primary path and this steps back to a text action. */}
        <button
          type="button"
          className={props.hasCode ? "btn-text" : "btn-clay"}
          disabled={props.busy}
          onClick={props.onSignIn}
        >
          Sign in with passkey
        </button>
      </div>
      {/* Announced, like the code error above: a sign-in failure here is the
          other expected outcome, and it is what tells a reader their account
          was not the one granted. */}
      {props.error !== null && (
        <p className="error" role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}
