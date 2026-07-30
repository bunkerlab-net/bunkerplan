import { useRef, useState } from "hono/jsx";
import { messageOf } from "./errors.ts";

/**
 * One write at a time against a list the panel then re-reads.
 *
 * Both panels that manage credentials do the same four things around a call:
 * hold a latch, mark themselves busy, render either kind of failure rather
 * than throwing it, and refresh the list on success - because neither appends
 * the new row itself, so a success that skipped the refresh leaves the reader
 * looking at a list without the thing they just made.
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
  refresh: () => Promise<void>,
): {
  busy: boolean;
  /** True when the call was made and answered without an error. */
  run: <T>(
    operation: () => Promise<{
      data?: T | null;
      error?: { message?: string } | null;
    }>,
    fallback: string,
    onData?: (data: T | null) => void,
  ) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  /*
   * Callers reach this as `void write(...)` from an event handler, so it may
   * not reject: the call can throw before it ever gets to `refresh`, and there
   * is no handler upstream to catch it.
   */
  const run = async <T>(
    operation: () => Promise<{
      data?: T | null;
      error?: { message?: string } | null;
    }>,
    fallback: string,
    onData?: (data: T | null) => void,
  ): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await operation();
      if (result.error) {
        // `messageOf`, not `?? fallback`: an empty or whitespace-only message
        // renders a blank error line, and `??` only catches the absent one.
        // The thrown path below already reads it this way.
        setError(messageOf(result.error, fallback));
        return false;
      }
      setError(null);
      onData?.(result.data ?? null);
      await refresh();
      return true;
    } catch (cause) {
      setError(messageOf(cause, fallback));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return { busy, run };
}
