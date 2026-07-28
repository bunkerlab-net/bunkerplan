import { useCallback, useEffect, useState } from "hono/jsx";
import { authClient } from "./auth.ts";

interface PasskeyRow {
  id: string;
  name?: string | null | undefined;
  createdAt?: Date | null | undefined;
}

/**
 * The message to show for a failure that was thrown rather than returned.
 *
 * Falls back to the wording the same failure carries when it comes back as a
 * `result.error`, so the two paths read alike. `String(cause)` is not that
 * fallback: on a plain object it renders "[object Object]", and an `Error`
 * with an empty message would blank the line entirely.
 */
function reason(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : fallback;
}

/** Passkeys, and the two ceremonies that change them. */
function usePasskeys() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * None of these three may reject. Every caller is `void add()` or
   * `void remove(id)` from an event handler, so a throw from the client -
   * a network failure, or a WebAuthn ceremony the browser aborts - would
   * surface as an unhandled rejection and nothing on screen, rather than as
   * the error line this panel already has.
   */
  const refresh = useCallback(async () => {
    try {
      const result = await authClient().passkey.listUserPasskeys();
      if (result.error) {
        setError(result.error.message ?? "could not list passkeys");
        return;
      }
      setError(null);
      setPasskeys(result.data ?? []);
    } catch (cause) {
      setError(reason(cause, "could not list passkeys"));
    }
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
    } catch (cause) {
      setError(reason(cause, "could not add a passkey"));
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
    } catch (cause) {
      setError(reason(cause, "could not delete the passkey"));
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
                {/* A disabled button takes no focus, so its `title` reaches
                    neither a keyboard nor a screen reader - the reason has to
                    be text on the page. Rendered in place of the control,
                    because with one passkey there is nothing to press. */}
                {props.onlyOne ? (
                  <span className="muted">
                    Deleting your only passkey would lock you out
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn-text btn-text-clay"
                    aria-label={`Delete ${item.name ?? "this passkey"}`}
                    disabled={props.busy}
                    onClick={() => void props.onDelete(item.id)}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
