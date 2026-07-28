import { useState } from "hono/jsx";
import { authClient } from "./auth.ts";

type Outcome = { error?: unknown } | undefined;

function messageOf(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    return failure.message;
  }
  return "authentication failed";
}

/**
 * Where a ceremony lands, refused unless it is a path on this origin.
 *
 * Today every caller passes a literal or a plan id the server validated to
 * lowercase alphanumerics, so nothing can reach here with a scheme in it.
 * The check is local anyway: this is the one place the app hands a string to
 * `location.assign`, and an open redirect out of a signed-in ceremony is a
 * phishing primitive.
 *
 * Resolved against the current origin rather than pattern-matched, because
 * the string checks alone are not enough: a URL parser strips tabs, newlines,
 * and carriage returns before parsing, so `/\tevil.com` and `/<CR>/evil.com`
 * do not look protocol-relative until after they already are. Those are
 * refused outright, backslashes with them, and anything that resolves off
 * this origin.
 */
function samePathOnly(destination: string): string {
  if (
    !destination.startsWith("/") ||
    /[\t\n\r\\]/.test(destination) ||
    destination.startsWith("//")
  ) {
    return "/dashboard";
  }
  try {
    const resolved = new URL(destination, window.location.origin);
    if (resolved.origin !== window.location.origin) return "/dashboard";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/dashboard";
  }
}

/**
 * One passkey ceremony runner shared by the nav and the sign-in card, so a
 * failure surfaces in a single place rather than once per component.
 *
 * `destination` is where a successful ceremony lands. The gate page passes
 * its own plan URL: signing in there is how an owner or a grantee gets past
 * the gate, and bouncing them to the dashboard would lose the plan they came
 * for.
 */
export function usePasskeyAction(destination = "/dashboard") {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    setError(null);
    try {
      const failure = (await action())?.error;
      if (failure) {
        setError(messageOf(failure));
        setBusy(false);
        return;
      }
      // Both ceremonies end by a full document load rather than a client-side
      // transition: registration signs the user in via a Set-Cookie on the
      // verify-registration response, but `addPasskey` does not notify the
      // client's session store (it normally runs with a session already
      // present), so an in-page transition would arrive still believing it is
      // signed out and bounce straight back off the guard.
      window.location.assign(samePathOnly(destination));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const register = () =>
    void run(() =>
      authClient().passkey.addPasskey({ name: "Primary passkey" }),
    );

  const signIn = () => void run(() => authClient().signIn.passkey());

  return { error, busy, register, signIn };
}
