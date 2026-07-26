import { useState } from "react";
import { authClient } from "./auth.ts";

interface DangerZoneProps {
  handle: string;
}

export function DangerZone({ handle }: DangerZoneProps) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onDelete = async () => {
    setBusy(true);
    try {
      let result = await authClient().deleteUser();
      // Deleting an account requires a FRESH session (default freshAge 24h)
      // and there is no password to re-enter, so a returning user routinely
      // hits SESSION_EXPIRED. Re-run the WebAuthn ceremony - which mints a new
      // session - and retry once.
      if (result.error?.code === "SESSION_EXPIRED") {
        const reauth = await authClient().signIn.passkey();
        if (reauth?.error) {
          setError(reauth.error.message ?? "re-authentication failed");
          return;
        }
        result = await authClient().deleteUser();
      }
      if (result.error) {
        setError(result.error.message ?? "could not delete the account");
        return;
      }
      window.location.assign("/");
    } finally {
      setBusy(false);
    }
  };

  return (
    /*
     * The palette has no danger colour and forbids inventing one, so gravity
     * comes from the system's only inversion surface plus the typed
     * confirmation, rather than from red.
     */
    <section className="card card-dark">
      <h2 className="card-title">Delete this account</h2>
      <p>
        This removes the account itself, every plan you have uploaded, every API
        key, and every passkey. Public URLs stop resolving, though a cached copy
        can survive for up to five minutes. It cannot be undone.
      </p>
      <div className="row" style={{ marginTop: "24px" }}>
        <label htmlFor="confirm-handle" className="confirm-label">
          Type <code>{handle}</code> to confirm
        </label>
        <input
          id="confirm-handle"
          type="text"
          value={typed}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />
        <button
          type="button"
          className="btn-outline-dark"
          disabled={busy || typed !== handle}
          onClick={() => void onDelete()}
        >
          Delete account
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}
