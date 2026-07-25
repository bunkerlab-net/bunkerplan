import { authClient } from "./auth.ts";
import { SiteFooter, SiteNav } from "./Chrome.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { Landing } from "./Landing.tsx";
import { usePasskeyAction } from "./passkey.ts";

export function App() {
  const { data: session, isPending } = authClient().useSession();
  // One ceremony runner for the whole page: the nav's "Sign in" and the
  // landing card's two buttons share a single busy flag and error.
  const passkey = usePasskeyAction();
  const handle = session?.user.name ?? null;

  return (
    <div className="page">
      <SiteNav handle={handle} busy={passkey.busy} onSignIn={passkey.signIn} />
      <main id="main">
        {isPending ? (
          <div className="shell hero">
            <p className="muted">Loading…</p>
          </div>
        ) : handle === null ? (
          <Landing
            error={passkey.error}
            busy={passkey.busy}
            onRegister={passkey.register}
            onSignIn={passkey.signIn}
          />
        ) : (
          <Dashboard handle={handle} />
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
