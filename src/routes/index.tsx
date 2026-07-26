import { createFileRoute } from "@tanstack/react-router";
import { authClient } from "../client/auth.ts";
import { Hydrated, SiteFrame } from "../client/Chrome.tsx";
import { Landing } from "../client/Landing.tsx";
import { usePasskeyAction } from "../client/passkey.ts";

export const Route = createFileRoute("/")({
  component: () => (
    <Hydrated>
      <LandingPage />
    </Hydrated>
  ),
});

/**
 * The landing page is the root for everyone. A signed-in visitor is not
 * redirected to the dashboard - the copy here is what documents the API - but
 * the sign-in card gives way to a route through to it, because the ceremony
 * buttons would only add a second passkey to a live session.
 */
function LandingPage() {
  const { data: session, isPending } = authClient().useSession();
  // One ceremony runner for the whole page: the nav's "Sign in" and the landing
  // card's two buttons share a single busy flag and error.
  const passkey = usePasskeyAction();
  const handle = session?.user.name ?? null;
  // An unresolved session looks exactly like a signed-out one here, so the
  // controls that would act on it stay disabled until it lands.
  const busy = isPending || passkey.busy;

  return (
    <SiteFrame handle={handle} busy={busy} onSignIn={passkey.signIn}>
      <Landing
        handle={handle}
        error={passkey.error}
        busy={busy}
        onRegister={passkey.register}
        onSignIn={passkey.signIn}
      />
    </SiteFrame>
  );
}
