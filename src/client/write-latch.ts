import { useCallback, useRef, useState } from "hono/jsx";
import { messageOf } from "./errors.ts";

/**
 * A settled call in the shape Better Auth's client returns one: the fault is
 * in `error` rather than thrown, so nothing rejects on a refusal.
 */
interface Settled<T> {
  data?: T | null;
  error?: { message?: string } | null;
}

/** What `useWriteLatch` hands a panel: one latch, two calling contracts. */
export interface WriteLatch {
  busy: boolean;
  /**
   * A call that reports its refusal in `error`. True when the call was made
   * and answered without one.
   */
  run: <T>(
    operation: () => Promise<Settled<T>>,
    fallback: string,
    onData?: (data: T | null) => void,
  ) => Promise<boolean>;
  /**
   * A call that throws its refusal. True when it resolved.
   *
   * Whatever the work returns is discarded: a caller that needs the value
   * reads it inside the thunk, where it is in scope, rather than through a
   * second channel out of here.
   */
  write: (
    operation: () => Promise<unknown>,
    fallback: string,
  ) => Promise<boolean>;
}

/**
 * Reconciles a `{ data, error }` result into `latched`'s one answer: the
 * message to show, or null when the call landed. Module-level because it
 * closes over nothing the hook owns.
 *
 * `messageOf`, not `?? fallback`: an empty or whitespace-only message renders
 * a blank error line, and `??` only catches the absent one. The thrown path
 * reads it the same way.
 */
async function settle<T>(
  operation: () => Promise<Settled<T>>,
  fallback: string,
  onData?: (data: T | null) => void,
): Promise<string | null> {
  const result = await operation();
  if (result.error) return messageOf(result.error, fallback);
  onData?.(result.data ?? null);
  return null;
}

/**
 * One write at a time against a list the panel then re-reads.
 *
 * Every panel that mutates something does the same four things around a call:
 * hold a latch, mark itself busy, render the failure rather than throwing it,
 * and refresh the list on success - because none of them appends the new row
 * itself, so a success that skipped the refresh leaves the reader looking at a
 * list without the thing they just made.
 *
 * Two error contracts reach this, which is why there are two entry points over
 * one latch rather than one entry point per panel. The credentials panels call
 * Better Auth, which resolves a refusal into `{ data, error }`; the plans panel
 * calls src/client/api.ts, whose wrappers throw the server's reason. Both are
 * rendered through `messageOf`, so a refusal reads the same whichever way it
 * arrived, and neither panel carries its own copy of the latch.
 *
 * The latch is a ref rather than the `busy` state. Two presses in one tick both
 * read the value their own render closed over, and `disabled` needs a re-render
 * to appear, so neither guards the call. What that costs is a second API key
 * nobody asked for, a second WebAuthn prompt for a credential already being
 * registered, or a second delete of a row that is already gone.
 *
 * One latch per hook, shared by every write the panel makes, which matches
 * `busy`: each of these already disables the other's button.
 */
export function useWriteLatch(
  setError: (message: string | null) => void,
  /**
   * Must not reject.
   *
   * Every caller's list call catches its own failures and renders them, which
   * is why there is no separate handling for one here: a rejection would come
   * out of the `catch` below wearing the write's fallback - "could not add a
   * passkey" for a passkey that was added - and the write it misdescribes has
   * already happened. Keeping that impossible is the caller's job, and cheaper
   * than a second error channel for a state neither can reach.
   */
  refresh: () => Promise<void>,
): WriteLatch {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  /*
   * The latch, the busy flag, and the refresh - everything both contracts
   * share. `attempt` resolves to the message to show, or null when the write
   * landed, so the two shapes are reconciled by their callers above and this
   * has one answer to act on.
   *
   * Callers reach the pair below as `void write(...)` from an event handler, so
   * neither may reject: the call can throw before it ever gets to `refresh`,
   * and there is no handler upstream to catch it.
   *
   * Memoised, like the two wrappers over it, so the panels can hand these down
   * as props without the identity changing on every render. Nothing depends on
   * that today, but a changing identity is the kind of thing that turns a
   * future `useEffect` in a child into a loop.
   */
  const latched = useCallback(
    async (
      attempt: () => Promise<string | null>,
      fallback: string,
    ): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      /*
       * The previous attempt's refusal is not about this one. Cleared before
       * the call rather than after a success, so a retry does not run under the
       * message that described the last failure - and a second failure replaces
       * it rather than looking like the same one never went away.
       */
      setError(null);
      setBusy(true);
      try {
        const failure = await attempt();
        if (failure !== null) {
          setError(failure);
          return false;
        }
        await refresh();
        return true;
      } catch (cause) {
        setError(messageOf(cause, fallback));
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [setError, refresh],
  );

  const run = useCallback(
    <T>(
      operation: () => Promise<Settled<T>>,
      fallback: string,
      onData?: (data: T | null) => void,
    ): Promise<boolean> =>
      latched(() => settle(operation, fallback, onData), fallback),
    [latched],
  );

  const write = useCallback(
    (operation: () => Promise<unknown>, fallback: string): Promise<boolean> =>
      latched(async () => {
        await operation();
        return null;
      }, fallback),
    [latched],
  );

  return { busy, run, write };
}
