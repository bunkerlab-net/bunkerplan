import { apiKeyClient } from "@better-auth/api-key/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { useEffect, useState } from "hono/jsx";

function makeClient() {
  return createAuthClient({
    // WebAuthn requires the client's real origin, and it must match
    // PUBLIC_BASE_URL on the server or the ceremony is rejected.
    baseURL: window.location.origin,
    plugins: [passkeyClient(), apiKeyClient()],
  });
}

export type AuthClient = ReturnType<typeof makeClient>;

let client: AuthClient | undefined;

/**
 * Constructed lazily and only in the browser - `window` is undefined during
 * the server render.
 */
export function authClient(): AuthClient {
  if (typeof window === "undefined") {
    throw new Error("authClient() is browser-only");
  }
  client ??= makeClient();
  return client;
}

interface SessionState {
  data: { user: { name: string } } | null;
  isPending: boolean;
}

/**
 * The React build of Better Auth shipped a `useSession` hook; the vanilla
 * client exposes the same thing as a nanostore atom instead. Subscribing to it
 * is the whole difference, and it is five lines rather than a React runtime.
 *
 * The initial value is read synchronously so the first client render matches
 * what the server produced - an unresolved session and a signed-out one look
 * identical, which is what makes hydration line up.
 */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    data: null,
    isPending: true,
  });

  useEffect(() => {
    const store = authClient().useSession;
    setState(store.get() as SessionState);
    return store.subscribe((next) => setState(next as SessionState));
  }, []);

  return state;
}
