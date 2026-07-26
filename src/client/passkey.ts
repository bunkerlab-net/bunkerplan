import { useState } from "react";
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
 * One passkey ceremony runner shared by the nav and the sign-in card, so a
 * failure surfaces in a single place rather than once per component.
 */
export function usePasskeyAction() {
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
      // Both ceremonies end on the dashboard, and by a full document load
      // rather than a router navigation: registration signs the user in via a
      // Set-Cookie on the verify-registration response, but `addPasskey` does
      // not notify the client's session store (it normally runs with a session
      // already present), so a client-side navigation would arrive still
      // believing it is signed out and bounce straight back off the guard.
      window.location.assign("/dashboard");
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
