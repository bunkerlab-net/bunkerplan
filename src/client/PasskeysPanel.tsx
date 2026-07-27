import { useCallback, useEffect, useState } from "hono/jsx";
import { authClient } from "./auth.ts";

interface PasskeyRow {
  id: string;
  name?: string | null | undefined;
  createdAt?: Date | null | undefined;
}

/** Passkeys, and the two ceremonies that change them. */
function usePasskeys() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const result = await authClient().passkey.listUserPasskeys();
    if (result.error) {
      setError(result.error.message ?? "could not list passkeys");
      return;
    }
    setError(null);
    setPasskeys(result.data ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    setBusy(true);
    try {
      const result = await authClient().passkey.addPasskey({
        name: `Passkey ${passkeys.length + 1}`,
      });
      if (result?.error) {
        setError(result.error.message ?? "could not add a passkey");
        return;
      }
      setError(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      const result = await authClient().passkey.deletePasskey({ id });
      if (result.error) {
        setError(result.error.message ?? "could not delete the passkey");
        return;
      }
      setError(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return { passkeys, error, busy, add, remove };
}

export function PasskeysPanel() {
  const { passkeys, error, busy, add, remove } = usePasskeys();
  // Deleting the last one would lock the account out.
  const onlyOne = passkeys.length === 1;

  return (
    <section className="card">
      <h2 className="card-title">Passkeys</h2>
      <p className="muted">
        Passkeys are the only way into this account. Keep at least two if you
        use more than one device.
      </p>
      <div className="row" style={{ marginTop: "16px" }}>
        <button
          type="button"
          className="btn-ivory"
          disabled={busy}
          onClick={() => void add()}
        >
          Add a passkey
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
      {passkeys.length === 0 ? (
        <p className="empty" style={{ marginTop: "24px" }}>
          No passkeys.
        </p>
      ) : (
        <PasskeysTable
          passkeys={passkeys}
          busy={busy}
          onlyOne={onlyOne}
          onDelete={remove}
        />
      )}
    </section>
  );
}

function PasskeysTable(props: {
  passkeys: PasskeyRow[];
  busy: boolean;
  /** Deleting the last one would lock the account out. */
  onlyOne: boolean;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <section
      className="table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1).
      tabIndex={0}
      aria-label="Passkeys"
    >
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Added</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.passkeys.map((item) => (
            <tr key={item.id}>
              <td>{item.name ?? "-"}</td>
              <td>
                {item.createdAt
                  ? new Date(item.createdAt).toLocaleString()
                  : "-"}
              </td>
              <td className="actions">
                <button
                  type="button"
                  className="btn-text btn-text-clay"
                  disabled={props.busy || props.onlyOne}
                  title={
                    props.onlyOne
                      ? "Deleting your only passkey would lock you out"
                      : undefined
                  }
                  onClick={() => void props.onDelete(item.id)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
