import { useRef, useState } from "hono/jsx";
import { authClient } from "./auth.ts";
import { controlValue } from "./dom.ts";
import { messageOf } from "./errors.ts";

interface DangerZoneProps {
  handle: string;
}

/**
 * Deletes the account, re-authenticating once if the session is too old.
 *
 * Deleting requires a FRESH session (Better Auth's default `freshAge` is 24h)
 * and there is no password to re-enter, so a returning visitor routinely hits
 * `SESSION_EXPIRED`. Re-running the WebAuthn ceremony mints a new session,
 * after which the delete is retried exactly once.
 *
 * Returns the message to show, or `null` when the account is gone. Lifted out
 * of the component because the handler around it is about latches and
 * navigation, and this is about Better Auth's freshness rule.
 */
async function deleteAccount(): Promise<string | null> {
  let result = await authClient().deleteUser();
  if (result.error?.code === "SESSION_EXPIRED") {
    const reauth = await authClient().signIn.passkey();
    if (reauth?.error) {
      return reauth.error.message ?? "re-authentication failed";
    }
    result = await authClient().deleteUser();
  }
  if (result.error) {
    return result.error.message ?? "could not delete the account";
  }
  return null;
}

export function DangerZone({ handle }: DangerZoneProps) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The same guard as `busy`, but readable in the turn it is set.
   *
   * `busy` is state, so a handler sees the value from the render that created
   * it: two clicks in one tick both read `false` and both start deleting. The
   * same shape of bug as the unlock box in PlanGate.tsx, and this is the one
   * irreversible action in the app - the second pass would re-run the WebAuthn
   * ceremony against an account the first has already removed.
   *
   * Released in the `finally` below rather than on individual paths: both
   * refusal returns leave the `try` without entering `catch`, and a latch they
   * skipped would ignore every retry afterwards while the button looked live.
   * The one exception is a navigation that actually started, which keeps it -
   * see `leaving`.
   */
  const inFlight = useRef(false);

  const onDelete = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    /*
     * Set only once the account is gone and the page is leaving. `assign()` is
     * asynchronous, so without this the `finally` below would re-enable the
     * button during the navigation - on an account that no longer exists.
     */
    let leaving = false;
    try {
      const refusal = await deleteAccount();
      if (refusal !== null) {
        setError(refusal);
        return;
      }
      window.location.assign("/");
      // After the call, not before: an `assign` that throws lands in the
      // `catch` below, and a flag already set would wedge the button on a
      // navigation that never started.
      leaving = true;
    } catch (cause) {
      // A dropped call throws rather than returning `{ error }`. Without this
      // the rejection escapes `void onDelete()` unhandled and the button just
      // re-enables, leaving the visitor no idea the deletion did not happen.
      setError(messageOf(cause, "could not delete the account"));
    } finally {
      // Every refusal returns out of the `try` without reaching the `catch`,
      // so the release belongs here: a latch cleared only on the thrown path
      // would ignore each retry afterwards while the button looked live.
      if (!leaving) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  return (
    /*
     * The palette has no danger colour and forbids inventing one, so gravity
     * comes from the system's only inversion surface plus the typed
     * confirmation, rather than from red.
     */
    <section className="card card-dark">
      <h2 className="card-title">Delete this account</h2>
      <p>
        This removes the account itself, every plan you have uploaded, every API
        key, and every passkey. Public URLs stop resolving straight away. It
        cannot be undone.
      </p>
      <div className="row" style={{ marginTop: "24px" }}>
        <label htmlFor="confirm-handle" className="confirm-label">
          Type <code>{handle}</code> to confirm
        </label>
        <input
          id="confirm-handle"
          type="text"
          value={typed}
          autoComplete="off"
          onChange={(event: Event) => setTyped(controlValue(event))}
        />
        <button
          type="button"
          className="btn-outline-dark"
          disabled={busy || typed !== handle}
          onClick={() => void onDelete()}
        >
          Delete account
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}
