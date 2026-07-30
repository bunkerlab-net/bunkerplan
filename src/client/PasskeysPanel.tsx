import { useCallback, useEffect, useRef, useState } from "hono/jsx";
import { authClient } from "./auth.ts";
import { messageOf } from "./errors.ts";

interface PasskeyRow {
  id: string;
  name?: string | null | undefined;
  createdAt?: Date | null | undefined;
}

/**
 * One write against the passkey list at a time: busy while it runs, the list
 * refreshed after it, and either kind of failure rendered rather than thrown.
 *
 * The latch is a ref because `busy` is state - two presses in one tick both read
 * the value their render closed over - and `disabled` needs a re-render to
 * appear, so it never guarded the call. Neither ceremony wants doing twice.
 */
function usePasskeyWrite(
  refresh: () => Promise<void>,
  setError: (message: string | null) => void,
) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const run = async (
    operation: () => Promise<{ error?: { message?: string } | null }>,
    fallback: string,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await operation();
      if (result.error) {
        // `messageOf`, not `?? fallback`: an empty or whitespace-only message
        // renders a blank error line, and `??` only catches the absent one. The
        // thrown path below already reads it this way.
        setError(messageOf(result.error, fallback));
        return;
      }
      setError(null);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause, fallback));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return { busy, run };
}

/** Passkeys, and the two ceremonies that change them. */
function usePasskeys() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * False until the first list call has answered. Without it the panel says
   * "No passkeys" for the length of that request, to an account that cannot
   * exist without one.
   */
  const [loaded, setLoaded] = useState(false);

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
      setError(messageOf(cause, "could not list passkeys"));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { busy, run } = usePasskeyWrite(refresh, setError);

  const add = () =>
    run(
      () =>
        authClient().passkey.addPasskey({
          name: `Passkey ${passkeys.length + 1}`,
        }),
      "could not add a passkey",
    );

  const remove = (id: string) =>
    run(
      () => authClient().passkey.deletePasskey({ id }),
      "could not delete the passkey",
    );

  return { passkeys, error, busy, loaded, add, remove };
}

export function PasskeysPanel() {
  const { passkeys, error, busy, loaded, add, remove } = usePasskeys();
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
        // Nothing is claimed while the first list is in flight, and nothing
        // at all when it failed: the error line above is the whole story
        // then, and "No passkeys" beside it would be a second, wrong one.
        error === null && (
          <p className="empty" style={{ marginTop: "24px" }}>
            {loaded ? "No passkeys." : "Loading…"}
          </p>
        )
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
    /*
     * No `role="region"`: a named `<section>` already has it implicitly - see
     * the same note in ApiKeysPanel.tsx.
     */
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
