import { useCallback, useEffect, useState } from "hono/jsx";
import { authClient } from "./auth.ts";
import { controlValue } from "./dom.ts";

interface KeyRow {
  id: string;
  name: string | null;
  start: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const DAY_SECONDS = 86_400;

/** Values are `expiresIn` in SECONDS; the plugin's min/max are in days. */
const EXPIRY_CHOICES: ReadonlyArray<{ label: string; seconds: number | null }> =
  [
    { label: "Never expires", seconds: null },
    { label: "30 days", seconds: 30 * DAY_SECONDS },
    { label: "90 days", seconds: 90 * DAY_SECONDS },
    { label: "365 days", seconds: 365 * DAY_SECONDS },
  ];

function Reveal({
  value,
  onDismiss,
}: {
  value: string;
  onDismiss: () => void;
}) {
  return (
    <div className="notice">
      <p>
        <strong>Copy this now - you will not see it again.</strong>
      </p>
      <div className="row">
        <code>{value}</code>
        <button
          type="button"
          className="btn-text"
          onClick={() => void navigator.clipboard.writeText(value)}
        >
          Copy
        </button>
        <button type="button" className="btn-text" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * The list, and the call that reloads it.
 *
 * `refresh` never rejects. Every mutation below awaits it, and each is called
 * as `void create(...)` from an event handler with no rejection handler - so
 * a list call that threw would surface as an unhandled rejection and nothing
 * on screen, rather than as the error line this panel already has.
 */
function useKeyList() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await authClient().apiKey.list();
      if (result.error) {
        setError(result.error.message ?? "could not list API keys");
        return;
      }
      setError(null);
      setKeys(result.data?.apiKeys ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { keys, error, setError, busy, setBusy, refresh };
}

/** Keys, and the three calls that change them. */
function useApiKeys() {
  const { keys, error, setError, busy, setBusy, refresh } = useKeyList();
  const [plaintext, setPlaintext] = useState<string | null>(null);

  // Both of these are called as `void create(...)` / `void revoke(...)` from
  // an event handler, so neither may reject: the call itself can throw before
  // it ever reaches `refresh`, and there is no handler upstream to catch it.
  const create = async (name: string, expiryIndex: number) => {
    setBusy(true);
    try {
      const seconds = EXPIRY_CHOICES[expiryIndex]?.seconds ?? null;
      const result = await authClient().apiKey.create({
        name: name.trim() === "" ? "API key" : name.trim(),
        ...(seconds === null ? {} : { expiresIn: seconds }),
      });
      if (result.error) {
        setError(result.error.message ?? "could not create API key");
        return false;
      }
      setError(null);
      // The only time the plaintext key is ever returned.
      setPlaintext(result.data?.key ?? null);
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (keyId: string) => {
    setBusy(true);
    try {
      const result = await authClient().apiKey.delete({ keyId });
      if (result.error) {
        setError(result.error.message ?? "could not revoke API key");
        return;
      }
      setError(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return { keys, plaintext, setPlaintext, error, busy, create, revoke };
}

export function ApiKeysPanel() {
  const { keys, plaintext, setPlaintext, error, busy, create, revoke } =
    useApiKeys();
  const [name, setName] = useState("");
  const [expiryIndex, setExpiryIndex] = useState(0);

  return (
    <section className="card">
      <h2 className="card-title">API keys</h2>
      <p className="muted">
        A key authorises upload, replacement, delete, and reading any plan you
        can read. It cannot list your plans or change who a plan is shared with.
        Send it as <code>x-api-key</code>.
      </p>
      <CreateKeyForm
        name={name}
        expiryIndex={expiryIndex}
        busy={busy}
        onName={setName}
        onExpiryIndex={setExpiryIndex}
        onCreate={() => {
          void create(name, expiryIndex).then((ok) => {
            if (ok) setName("");
          });
        }}
      />
      {plaintext !== null && (
        <Reveal value={plaintext} onDismiss={() => setPlaintext(null)} />
      )}
      {error !== null && <p className="error">{error}</p>}
      {keys.length === 0 ? (
        <p className="empty" style={{ marginTop: "24px" }}>
          No API keys.
        </p>
      ) : (
        <KeysTable keys={keys} busy={busy} onRevoke={revoke} />
      )}
    </section>
  );
}

function CreateKeyForm(props: {
  name: string;
  expiryIndex: number;
  busy: boolean;
  onName: (value: string) => void;
  onExpiryIndex: (index: number) => void;
  onCreate: () => void;
}) {
  return (
    <div className="row" style={{ marginTop: "16px" }}>
      <input
        type="text"
        placeholder="Key name"
        // A placeholder is not a name: it is gone the moment there is a value,
        // and several screen readers never announce it at all.
        aria-label="Key name"
        value={props.name}
        onChange={(event: Event) => props.onName(controlValue(event))}
      />
      <select
        aria-label="How long the key lasts"
        value={props.expiryIndex}
        onChange={(event: Event) =>
          props.onExpiryIndex(Number(controlValue(event)))
        }
      >
        {EXPIRY_CHOICES.map((choice, index) => (
          <option key={choice.label} value={index}>
            {choice.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn-ivory"
        disabled={props.busy}
        onClick={props.onCreate}
      >
        Create key
      </button>
    </div>
  );
}

function KeysTable(props: {
  keys: KeyRow[];
  busy: boolean;
  onRevoke: (keyId: string) => Promise<void>;
}) {
  return (
    <section
      className="table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1).
      tabIndex={0}
      aria-label="API keys"
    >
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.keys.map((item) => (
            <tr key={item.id}>
              <td>{item.name ?? "-"}</td>
              {/* `start` is the first characters of the full key, prefix
                  included - do not prepend `prefix` again. */}
              <td className="mono">{item.start ?? "-"}…</td>
              <td>
                {item.expiresAt === null
                  ? "Never"
                  : new Date(item.expiresAt).toLocaleString()}
              </td>
              <td className="actions">
                <button
                  type="button"
                  className="btn-text btn-text-clay"
                  disabled={props.busy}
                  onClick={() => void props.onRevoke(item.id)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
