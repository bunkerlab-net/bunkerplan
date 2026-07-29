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
      // `messageOf`, not `?? fallback`: Better Auth can hand back an empty or
      // whitespace-only message, and `??` only catches the absent one - the
      // rest render as a blank error line.
      return messageOf(reauth.error, "re-authentication failed");
    }
    result = await authClient().deleteUser();
  }
  if (result.error) {
    return messageOf(result.error, "could not delete the account");
  }
  return null;
}

/**
 * The deletion half of this panel: one irreversible call, and the latches that
 * keep it to one.
 *
 * Separate from the component because the two have nothing to say to each
 * other - the panel renders a typed confirmation, and this owns whether the
 * account still exists.
 */
function useAccountDeletion(): {
  error: string | null;
  busy: boolean;
  onDelete: () => Promise<void>;
} {
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
   * The one thing that keeps it closed is a delete that succeeded - see
   * `deleted`.
   */
  const inFlight = useRef(false);

  const onDelete = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    // The previous attempt's refusal is not about this one. Leaving it up
    // makes a retry look like it failed again before the call even lands.
    setError(null);
    setBusy(true);
    /*
     * Whether the account is gone, which is the thing that must hold the
     * latch - not whether the page moved. Once this is set there is nothing
     * left to delete, so no path below may re-enable the control: a second
     * press would run the ceremony against an account that no longer exists.
     */
    let deleted = false;
    try {
      const refusal = await deleteAccount();
      if (refusal !== null) {
        setError(refusal);
        return;
      }
      deleted = true;
      window.location.assign("/");
    } catch (cause) {
      // A dropped call throws rather than returning `{ error }`. Without this
      // the rejection escapes `void onDelete()` unhandled and the button just
      // re-enables, leaving the visitor no idea the deletion did not happen.
      setError(
        deleted
          ? // `assign` threw. Reporting the navigation error would read as a
            // failed deletion, and the account is already gone.
            "Your account is deleted. Reload the page to continue."
          : messageOf(cause, "could not delete the account"),
      );
    } finally {
      // Every refusal returns out of the `try` without reaching the `catch`,
      // so the release belongs here: a latch cleared only on the thrown path
      // would ignore each retry afterwards while the button looked live.
      if (!deleted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  return { error, busy, onDelete };
}

export function DangerZone({ handle }: DangerZoneProps) {
  const [typed, setTyped] = useState("");
  const { error, busy, onDelete } = useAccountDeletion();
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
