import { useCallback, useEffect, useState } from "react";
import { authClient } from "./auth.ts";

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

export function ApiKeysPanel() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [name, setName] = useState("");
  const [expiryIndex, setExpiryIndex] = useState(0);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const result = await authClient().apiKey.list();
    if (result.error) {
      setError(result.error.message ?? "could not list API keys");
      return;
    }
    setError(null);
    setKeys(result.data?.apiKeys ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = async () => {
    setBusy(true);
    try {
      const seconds = EXPIRY_CHOICES[expiryIndex]?.seconds ?? null;
      const result = await authClient().apiKey.create({
        name: name.trim() === "" ? "API key" : name.trim(),
        ...(seconds === null ? {} : { expiresIn: seconds }),
      });
      if (result.error) {
        setError(result.error.message ?? "could not create API key");
        return;
      }
      setError(null);
      setName("");
      // The only time the plaintext key is ever returned.
      setPlaintext(result.data?.key ?? null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (keyId: string) => {
    setBusy(true);
    try {
      const result = await authClient().apiKey.delete({ keyId });
      if (result.error) {
        setError(result.error.message ?? "could not revoke API key");
        return;
      }
      setError(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="card-title">API keys</h2>
      <p className="muted">
        A key authorises upload, replacement, and delete for your own plans, and
        nothing else. Send it as <code>x-api-key</code>.
      </p>
      <div className="row" style={{ marginTop: "16px" }}>
        <input
          type="text"
          placeholder="Key name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          value={expiryIndex}
          onChange={(event) => setExpiryIndex(Number(event.target.value))}
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
          disabled={busy}
          onClick={() => void onCreate()}
        >
          Create key
        </button>
      </div>
      {plaintext !== null && (
        <Reveal value={plaintext} onDismiss={() => setPlaintext(null)} />
      )}
      {error !== null && <p className="error">{error}</p>}
      {keys.length === 0 ? (
        <p className="empty" style={{ marginTop: "24px" }}>
          No API keys.
        </p>
      ) : (
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
            {keys.map((item) => (
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
                    className="btn-text"
                    disabled={busy}
                    onClick={() => void onRevoke(item.id)}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
