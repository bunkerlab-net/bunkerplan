import { useEffect } from "hono/jsx";
import { useSession } from "./auth.ts";
import { SiteFrame } from "./Chrome.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { Landing } from "./Landing.tsx";
import { usePasskeyAction } from "./passkey.ts";

/**
 * Everything a page needs that only the server knows. Serialised into the
 * document and read back on hydration, so both renders start from the same
 * inputs - which is what keeps the markup identical.
 */
export interface PageProps {
  name: "landing" | "dashboard";
  path: string;
  origin: string;
}

/**
 * The landing page is the root for everyone. A signed-in visitor is not
 * redirected to the dashboard - the copy here is what documents the API - but
 * the sign-in card gives way to a route through to it, because the ceremony
 * buttons would only add a second passkey to a live session.
 */
export function LandingPage({ path, origin }: PageProps) {
  const { data: session, isPending } = useSession();
  // One ceremony runner for the whole page: the nav's "Sign in" and the
  // landing card's two buttons share a single busy flag and error.
  const passkey = usePasskeyAction();
  const handle = session?.user.name ?? null;
  // An unresolved session looks exactly like a signed-out one here, so the
  // controls that would act on it stay disabled until it lands. On the server
  // it is always unresolved, which is why the first client render matches.
  const busy = isPending || passkey.busy;

  return (
    <SiteFrame
      handle={handle}
      busy={busy}
      onSignIn={passkey.signIn}
      path={path}
    >
      <Landing
        handle={handle}
        error={passkey.error}
        busy={busy}
        origin={origin}
        onRegister={passkey.register}
        onSignIn={passkey.signIn}
      />
    </SiteFrame>
  );
}

/**
 * Signed-in only. The guard runs in the browser because the session lives
 * behind the auth client, and it is navigation rather than access control:
 * every route this page calls authorises the session server-side.
 *
 * A session that failed to load is not a signed-out one. Redirecting on it
 * would throw a signed-in reader back to the landing page over a dropped
 * request, so a failure says so and leaves them somewhere they can retry.
 */
export function DashboardPage({ path }: PageProps) {
  const { data: session, error, isPending } = useSession();
  const handle = session?.user.name ?? null;

  useEffect(() => {
    if (!isPending && error === null && handle === null) {
      window.location.assign("/");
    }
  }, [isPending, error, handle]);

  return (
    <SiteFrame handle={handle} path={path}>
      {handle === null ? (
        <div className="shell hero">
          {error === null ? (
            <p className="muted">Loading…</p>
          ) : (
            <p className="error">
              Could not load your session. Check your connection and{" "}
              <a href="/dashboard">try again</a>.
            </p>
          )}
        </div>
      ) : (
        <Dashboard handle={handle} />
      )}
    </SiteFrame>
  );
}

export function Page(props: PageProps) {
  return props.name === "landing" ? (
    <LandingPage {...props} />
  ) : (
    <DashboardPage {...props} />
  );
}
