import { apiKeyClient } from "@better-auth/api-key/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

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
 * Constructed lazily and only in the browser - `window` is undefined under SSR.
 */
export function authClient(): AuthClient {
  if (typeof window === "undefined") {
    throw new Error("authClient() is browser-only");
  }
  client ??= makeClient();
  return client;
}
