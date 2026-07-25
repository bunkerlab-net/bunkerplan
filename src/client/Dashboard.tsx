import { useState } from "react";
import { ApiKeysPanel } from "./ApiKeysPanel.tsx";
import { authClient } from "./auth.ts";
import { DangerZone } from "./DangerZone.tsx";
import { PasskeysPanel } from "./PasskeysPanel.tsx";
import { PlansPanel } from "./PlansPanel.tsx";

function SignedOut() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (
    action: () => Promise<{ error?: unknown } | undefined>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      const failure = result?.error;
      if (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : typeof failure === "object" &&
                failure !== null &&
                "message" in failure &&
                typeof failure.message === "string"
              ? failure.message
              : "authentication failed",
        );
        setBusy(false);
        return;
      }
      // Registration signs the user straight in via a Set-Cookie on the
      // verify-registration response, but `addPasskey` does not notify the
      // client's session store (it normally runs with a session already
      // present). Reloading is the boring way to pick the cookie up.
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Sign in</h2>
      <p className="muted">
        No email, no username, no password. A passkey is the whole account.
      </p>
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            void run(() =>
              authClient().passkey.addPasskey({ name: "Primary passkey" }),
            )
          }
        >
          Register with passkey
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => authClient().signIn.passkey())}
        >
          Sign in
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}

export function Dashboard() {
  const { data: session, isPending } = authClient().useSession();

  if (isPending) return <p className="muted">Loading…</p>;
  if (!session) return <SignedOut />;

  return (
    <>
      <div className="row">
        <p className="muted">
          Signed in as <code>{session.user.name}</code>
        </p>
        <button
          type="button"
          onClick={() =>
            void authClient()
              .signOut()
              .then(() => window.location.reload())
          }
        >
          Sign out
        </button>
      </div>
      <PlansPanel />
      <ApiKeysPanel />
      <PasskeysPanel />
      <DangerZone handle={session.user.name} />
    </>
  );
}
