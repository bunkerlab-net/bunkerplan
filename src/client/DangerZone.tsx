import { useRef, useState } from "hono/jsx";
import {
  EXPECTED_ACCOUNT_HEADER,
  WRONG_ACCOUNT_CODE,
} from "../http/expected-account.ts";
import { authClient } from "./auth.ts";
import { controlValue } from "./dom.ts";
import { messageOf } from "./errors.ts";

interface DangerZoneProps {
  handle: string;
  /**
   * The account this panel may delete, resolved by the caller.
   *
   * A prop rather than a read of the auth client, because that client is
   * browser-only and this would otherwise reach for it during render.
   *
   * Null while the session is still resolving. Nothing is deleted in that
   * state - there is no id to compare a ceremony's answer against, and a
   * stand-in would be an id that silently cannot match.
   */
  userId: string | null;
}

/**
 * What an attempt did, rather than a message-or-null.
 *
 * `blocked` is separate from `refused` because it is terminal: the client is
 * no longer holding the session this panel was mounted for, and no further
 * press may reach `deleteUser`.
 */
type DeleteOutcome =
  | { kind: "deleted" }
  | { kind: "refused"; message: string }
  | { kind: "blocked"; message: string };

const WRONG_ACCOUNT =
  "This page is signed in as a different account now. Reload before deleting anything.";

const UNRESOLVED_SESSION =
  "Your session has not finished loading. Try again in a moment.";

/** The signed-in account's id, or null while the session is unresolved. */
const currentUserId = (): string | null =>
  authClient().useSession.get().data?.user?.id ?? null;

/**
 * Deletes, saying which account it means.
 *
 * The header is what makes the check atomic: the server refuses outright if
 * the session it authenticates is not this account.
 *
 * Two arguments because that is the endpoint's shape: the first is the request
 * body, the second is Better Auth's `fetchOptions` parameter - which is where
 * `headers` belongs. Not a `fetchOptions` key inside the body object.
 */
const deleteFor = (intended: string) =>
  authClient().deleteUser(
    {},
    { headers: { [EXPECTED_ACCOUNT_HEADER]: intended } },
  );

/**
 * Deletes the account this panel was mounted for, re-authenticating once if
 * the session is too old.
 *
 * Deleting requires a FRESH session (Better Auth's default `freshAge` is 24h)
 * and there is no password to re-enter, so a returning visitor routinely hits
 * `SESSION_EXPIRED`. Re-running the WebAuthn ceremony mints a new session,
 * after which the delete is retried exactly once.
 *
 * `intended` is checked on both sides of that ceremony. `signIn.passkey()`
 * names no account: it is a discoverable-credential ceremony, so the browser
 * offers every passkey registered for this site and the visitor picks one. On
 * a shared machine, or by simple misclick, that can be another account - and
 * the session it mints is that account's. Retrying against it would destroy an
 * account whose handle was never typed into the box, and because the client
 * session has genuinely changed, the check has to run before the first call
 * too: otherwise the next press deletes the wrong account with nothing left to
 * compare.
 */
async function deleteAccount(intended: string | null): Promise<DeleteOutcome> {
  /*
   * A client that already knows it is holding somebody else stops here, so a
   * doomed request is not made at all. It is not the guarantee, and is not
   * written as one: the store is a cache, and a sign-in in another tab can
   * still swap the session between this line and the request below.
   *
   * What closes that is `deleteFor`, which names the intended account in the
   * request itself. Better Auth compares it against the account that same
   * request authenticated, before anything is deleted - see
   * src/http/expected-account.ts. This check is the fast, local half; that
   * one is the sound half.
   *
   * An unresolved session is a different answer from a mismatched one. Either
   * id being absent means there is nothing to compare yet, and calling that
   * `blocked` would be terminal - the caller keeps its latch closed for a
   * refusal that says nothing about who is signed in, so a press landing
   * before the session arrives would kill the button for the rest of the
   * page's life.
   */
  const current = currentUserId();
  if (intended === null || current === null) {
    return { kind: "refused", message: UNRESOLVED_SESSION };
  }
  if (current !== intended) {
    return { kind: "blocked", message: WRONG_ACCOUNT };
  }

  let result = await deleteFor(intended);
  if (result.error?.code === "SESSION_EXPIRED") {
    const reauth = await authClient().signIn.passkey();
    if (reauth.error) {
      // `messageOf`, not `?? fallback`: Better Auth can hand back an empty or
      // whitespace-only message, and `??` only catches the absent one - the
      // rest render as a blank error line.
      return {
        kind: "refused",
        message: messageOf(reauth.error, "re-authentication failed"),
      };
    }
    /*
     * The ceremony's own answer, not the store: the store may not have caught
     * up, and this is the authoritative record of who was just signed in.
     *
     * Read straight - no `?.`, no `?? null` standing in for an absent id.
     * `@better-auth/passkey` 1.6.25 (`dist/client.d.mts`) declares
     * `signIn.passkey` as a five-arm union discriminated on `error`: every arm
     * carrying `error: null` also carries `data: { session, user }`, and every
     * arm with an error carries `data: null`. The check above eliminates the
     * error arms, so `data` is non-null here and `user.id` is a `string` -
     * which is why this typechecks without a cast. A branch for a missing id
     * would be handling a state the dependency cannot produce, and would have
     * to guess whether to call it a refusal or the wrong account.
     */
    if (reauth.data.user.id !== intended) {
      return { kind: "blocked", message: WRONG_ACCOUNT };
    }
    result = await deleteFor(intended);
  }
  if (result.error) {
    /*
     * The authoritative answer to the question the local check only guesses
     * at: the server compared the named account against the session that made
     * this request. Terminal for the same reason that check's mismatch is -
     * this client is holding somebody else, and pressing again cannot help.
     */
    if (result.error.code === WRONG_ACCOUNT_CODE) {
      return { kind: "blocked", message: WRONG_ACCOUNT };
    }
    return {
      kind: "refused",
      message: messageOf(result.error, "could not delete the account"),
    };
  }
  return { kind: "deleted" };
}

/**
 * The deletion half of this panel: one irreversible call, and the latches that
 * keep it to one.
 *
 * Separate from the component because the two have nothing to say to each
 * other - the panel renders a typed confirmation, and this owns whether the
 * account still exists.
 */
function useAccountDeletion(
  confirmed: boolean,
  userId: string | null,
): {
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
   * The one thing that keeps it closed is an attempt that must not be made
   * again - see `settled`.
   */
  const inFlight = useRef(false);
  /**
   * The account this panel was mounted for.
   *
   * The first resolved id wins, and a later different one cannot replace it: a
   * re-render carrying a new `userId` must not quietly redefine what "intended"
   * means. Seeded rather than frozen outright because the caller may render this
   * before the session resolves, and freezing `null` would leave the panel
   * permanently unable to delete anything.
   *
   * None of that is the load-bearing guard. This ref decides which account the
   * request names; what decides whether the delete happens is the server
   * comparing that name against the session the request authenticated, inside
   * one request. The checks in `deleteAccount` - the live session before the
   * first call, the ceremony's own answer after it - are the local, fast half,
   * and exist so a doomed request is not made rather than to make it safe.
   */
  const intended = useRef<string | null>(userId);
  if (intended.current === null) intended.current = userId;

  const onDelete = async () => {
    /*
     * The confirmation is re-checked here, not only through the button's
     * `disabled`. A `click` dispatched at a disabled button still runs its
     * listeners - only user activation is suppressed - so `disabled` is a
     * hint, and this is the one action in the app that cannot be taken back.
     */
    if (!confirmed || inFlight.current) return;
    inFlight.current = true;
    // The previous attempt's refusal is not about this one. Leaving it up
    // makes a retry look like it failed again before the call even lands.
    setError(null);
    setBusy(true);
    /*
     * Whether this attempt must be the last one. Set when the account is gone,
     * and when the session turned out to belong to somebody else - in both
     * cases a second press can only do harm, so no path below re-enables the
     * control. Navigation is a separate matter: `deleted` drives that.
     */
    let settled = false;
    let deleted = false;
    try {
      const outcome = await deleteAccount(intended.current);
      if (outcome.kind !== "deleted") {
        settled = outcome.kind === "blocked";
        setError(outcome.message);
        return;
      }
      settled = true;
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
      if (!settled) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  return { error, busy, onDelete };
}

export function DangerZone({ handle, userId }: DangerZoneProps) {
  const [typed, setTyped] = useState("");
  const { error, busy, onDelete } = useAccountDeletion(
    typed === handle,
    userId,
  );
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
