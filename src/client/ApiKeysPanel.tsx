import { useCallback, useEffect, useState } from "hono/jsx";
import { authClient } from "./auth.ts";
import { controlValue } from "./dom.ts";
import { EmptyOrLoading } from "./EmptyOrLoading.tsx";
import { messageOf } from "./errors.ts";
import { useCopy } from "./use-copy.ts";
import { useWriteLatch } from "./write-latch.ts";

interface KeyRow {
  id: string;
  name: string | null;
  start: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const DAY_SECONDS = 86_400;

/** Values are `expiresIn` in SECONDS; the plugin's min/max are in days. */
export const EXPIRY_CHOICES: ReadonlyArray<{
  label: string;
  seconds: number | null;
}> = [
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
  const { copy, copyFailed } = useCopy(value);

  return (
    <div className="notice">
      <p>
        <strong>Copy this now - you will not see it again.</strong>
      </p>
      <div className="row">
        <code>{value}</code>
        <button type="button" className="btn-text" onClick={copy}>
          Copy
        </button>
        <button type="button" className="btn-text" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {copyFailed && (
        // `error` and `role="alert"`, as ShareLink's does: nothing moved
        // focus, so a reader who pressed Copy and heard nothing would believe
        // it worked - and the key is shown once. `muted` said the opposite of
        // what this is.
        <p className="error" role="alert">
          Copying failed - select the key above instead.
        </p>
      )}
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
  /**
   * False until the first list call has answered. Without it the panel says
   * "No API keys." for the length of that request, to an account that may
   * well have several - the same gap the passkeys and plans panels close.
   */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await authClient().apiKey.list();
      if (result.error) {
        // `messageOf`, as everywhere else here: a whitespace-only message
        // renders a blank error line, and it also suppresses the empty state -
        // so the panel would show nothing at all where a reason belongs.
        setError(messageOf(result.error, "could not list API keys"));
        return;
      }
      setError(null);
      setKeys(result.data?.apiKeys ?? []);
    } catch (cause) {
      setError(messageOf(cause, "could not list API keys"));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { keys, error, setError, loaded, refresh };
}

/** Keys, and the three calls that change them. */
function useApiKeys() {
  const { keys, error, setError, loaded, refresh } = useKeyList();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const { busy, run } = useWriteLatch(setError, refresh);

  const create = (name: string, expiryIndex: number) => {
    const seconds = EXPIRY_CHOICES[expiryIndex]?.seconds ?? null;
    /*
     * The last key's plaintext goes before this one is asked for, not when the
     * answer arrives. A create that fails would otherwise leave the previous
     * secret on screen beside the error, reading as though it belonged to the
     * attempt that just failed - and it is shown once, so what is on screen is
     * the only copy its owner has.
     *
     * Inside the operation, so a call the latch refuses clears nothing. That
     * call is reachable: `disabled` needs a render to appear, so a press
     * landing in the same tick as one that took the latch runs from the
     * enabled render and is refused here instead. Wiping the visible secret on
     * behalf of a request that was never made is how the only copy gets lost.
     */
    return run(
      () => {
        setPlaintext(null);
        return authClient().apiKey.create({
          name: name.trim() === "" ? "API key" : name.trim(),
          ...(seconds === null ? {} : { expiresIn: seconds }),
        });
      },
      "could not create API key",
      // The only time the plaintext key is ever returned.
      (data) => setPlaintext(data?.key ?? null),
    );
  };

  const revoke = async (keyId: string) => {
    await run(
      () => authClient().apiKey.delete({ keyId }),
      "could not revoke API key",
    );
  };

  return {
    keys,
    plaintext,
    setPlaintext,
    error,
    busy,
    loaded,
    create,
    revoke,
  };
}

export function ApiKeysPanel() {
  const { keys, plaintext, setPlaintext, error, busy, loaded, create, revoke } =
    useApiKeys();
  const [name, setName] = useState("");
  const [expiryIndex, setExpiryIndex] = useState(0);

  return (
    <section className="card">
      <h2 className="card-title">API keys</h2>
      <p className="muted">
        A key authorises upload, replacement, renaming, delete, listing your
        plans, and reading any plan you can read. It can share a plan as it
        uploads it, but it cannot change how an existing plan is shared. Send it
        as <code>x-api-key</code>.
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
        // Nothing is claimed while the first list is in flight, and nothing
        // at all when it failed: the error line above is the whole story
        // then, and "No API keys." beside it would be a second, wrong one.
        error === null && (
          <EmptyOrLoading loaded={loaded} empty="No API keys." />
        )
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
    /*
     * No `role="region"`: a `<section>` with an accessible name already has
     * that role implicitly (ARIA in HTML), so spelling it out adds nothing an
     * assistive technology can tell apart. The `aria-label` is what supplies
     * the name, and without one the element would fall back to `generic`.
     */
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
                  included - do not prepend `prefix` again. The ellipsis is
                  what says the value is truncated, so it goes with the value:
                  "-…" would claim a placeholder had been cut short. */}
              <td className="mono">
                {item.start === null ? "-" : `${item.start}…`}
              </td>
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
