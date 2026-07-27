import { useCallback, useEffect, useRef, useState } from "hono/jsx";
import { MAX_PLAN_LABEL_LENGTH } from "../http/plan-label.ts";
import {
  addGrant,
  clearShareCode,
  deletePlan,
  getSharing,
  listPlans,
  type PlanSharing,
  type PlanSummary,
  type PlanVisibility,
  relabelPlan,
  removeGrant,
  replacePlan,
  rotateShareCode,
  setVisibility,
  uploadPlan,
} from "./api.ts";
import { inputOf } from "./dom.ts";

/** What the Sharing column says at a glance. */
function describeSharing(plan: PlanSummary): string {
  if (plan.visibility === "public") return "Public";
  return plan.hasShareCode ? "Private + code" : "Private";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}

/*
 * Mirrors the `accept` attribute for the drop path, which has no equivalent.
 * The extension is checked as well as the type because a drag off a file
 * manager can arrive with an empty `type`.
 */
function isHtml(file: File): boolean {
  return file.type === "text/html" || /\.html?$/i.test(file.name);
}

/** Runs work through the panel's one busy flag and one error line. */
type Guard = (work: () => Promise<unknown>) => Promise<boolean>;

interface SharingEditorProps {
  plan: PlanSummary;
  busy: boolean;
  guard: Guard;
}

/**
 * The three ways to share one plan, opened inline under its row.
 *
 * A minted code is held here and nowhere else: the server returns the
 * plaintext once and stores only a digest, so closing this editor is the last
 * time anyone can read it.
 */
function SharingEditor({ plan, busy, guard }: SharingEditorProps) {
  const [state, setState] = useState<PlanSharing | null>(null);
  const [failed, setFailed] = useState(false);
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setState(await getSharing(plan.id));
    } catch (cause) {
      // A flag of its own, because `guard` swallows the throw into the panel's
      // error line - without this the editor would sit on "Loading…" for as
      // long as the row stayed open. Rethrown so that line still fills in.
      setFailed(true);
      throw cause;
    }
  }, [plan.id]);

  useEffect(() => {
    void guard(load);
  }, [load, guard]);

  if (state === null) {
    return failed ? (
      <p className="muted">
        Could not load sharing for this plan.{" "}
        <button
          type="button"
          className="btn-text"
          disabled={busy}
          onClick={() => void guard(load)}
        >
          Try again
        </button>
      </p>
    ) : (
      <p className="muted">Loading…</p>
    );
  }

  const choose = (visibility: PlanVisibility) =>
    void guard(async () => {
      setState(await setVisibility(plan.id, visibility));
    });

  // A public plan is readable by anyone holding the URL, so neither a code nor
  // a grant gates anything. Both stay on screen rather than vanishing - they
  // are real state that applies again the moment this goes private, and
  // hiding them would read as having cleared them - but nothing here acts.
  const inert = state.visibility === "public";
  const locked = busy || inert;

  const submitGrant = (event: Event) => {
    event.preventDefault();
    // Enter submits even when the button is disabled, so every guard the
    // button carries must be repeated here.
    const wanted = handle.trim();
    if (locked || wanted === "") return;
    void guard(async () => {
      await addGrant(plan.id, wanted);
      setHandle("");
      await load();
    });
  };

  return (
    <div className="sharing">
      <div>
        <h3>Who can open it</h3>
        <div className="choices">
          {(["private", "public"] as const).map((option) => (
            <label className="choice" key={option}>
              <input
                type="radio"
                name={`visibility-${plan.id}`}
                value={option}
                checked={state.visibility === option}
                disabled={busy}
                onChange={() => choose(option)}
              />
              <span>
                {option === "private"
                  ? "Private - you, granted accounts, and anyone with the code"
                  : "Public - anyone holding the URL"}
              </span>
            </label>
          ))}
        </div>
        {inert && (
          <p className="muted">
            Anyone holding the URL can open this plan, so the code and the
            accounts below grant nothing extra. Make it private to use them.
          </p>
        )}
      </div>

      <div className={inert ? "sharing-inert" : undefined}>
        <h3>Share code</h3>
        <div className="row">
          <button
            type="button"
            className="btn-text"
            disabled={locked}
            onClick={() =>
              void guard(async () => {
                setCode(await rotateShareCode(plan.id));
                await load();
              })
            }
          >
            {state.hasShareCode ? "Regenerate" : "Create code"}
          </button>
          {state.hasShareCode && (
            <button
              type="button"
              className="btn-text btn-text-clay"
              disabled={locked}
              onClick={() =>
                void guard(async () => {
                  await clearShareCode(plan.id);
                  setCode(null);
                  await load();
                })
              }
            >
              Remove
            </button>
          )}
        </div>
        {code !== null && (
          <p>
            <strong>This is the only time the code is shown.</strong> Copy the
            link:
          </p>
        )}
        {code !== null && (
          // Encoded even though the alphabet is base62 and needs none: the
          // link is built here, and a future alphabet change must not silently
          // start producing broken URLs.
          <code className="snippet">
            {`${plan.url}?code=${encodeURIComponent(code)}`}
          </code>
        )}
        {code === null && state.hasShareCode && (
          <p className="muted">
            A code is set. It cannot be read back - regenerate to get a new one,
            which stops the old link working immediately.
          </p>
        )}
      </div>

      <div className={inert ? "sharing-inert" : undefined}>
        <h3>Shared with</h3>
        {state.grants.length === 0 ? (
          <p className="empty">No accounts yet.</p>
        ) : (
          <ul className="tag-list">
            {state.grants.map((granted) => (
              <li key={granted}>
                <span className="mono">{granted}</span>
                <button
                  type="button"
                  className="btn-text btn-text-clay"
                  disabled={locked}
                  onClick={() =>
                    void guard(async () => {
                      await removeGrant(plan.id, granted);
                      await load();
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          A handle is the value shown as <strong>Handle</strong> beside{" "}
          <strong>Sign out</strong> on that person's own dashboard - ask them
          for it.
        </p>
        {/* A real form, not a button beside an input: Enter in a text field
            submitting its form is native behaviour, and typing a handle then
            pressing Enter is what anyone will do. */}
        <form className="row" onSubmit={submitGrant}>
          <input
            type="text"
            placeholder="Account handle"
            aria-label={`Share plan ${plan.id} with an account`}
            value={handle}
            disabled={locked}
            onChange={(event: Event) => setHandle(inputOf(event).value)}
          />
          <button
            type="submit"
            className="btn-text"
            disabled={locked || handle.trim() === ""}
          >
            Add
          </button>
        </form>
      </div>
    </div>
  );
}

interface RowProps {
  plan: PlanSummary;
  busy: boolean;
  guard: Guard;
  onRelabel: (id: string, label: string | null) => Promise<boolean>;
  onReplace: (id: string, files: FileList | null) => void;
  onDelete: (id: string) => void;
}

function PlanRow({
  plan,
  busy,
  guard,
  onRelabel,
  onReplace,
  onDelete,
}: RowProps) {
  const stored = plan.label ?? "";
  const [draft, setDraft] = useState(stored);
  const [sharing, setSharing] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  // Ids are unique per plan, so this is stable across renders without a hook.
  const sharingId = `sharing-${plan.id}`;

  // A refresh can bring a different label for this row - the id is the React
  // key, so the component survives and the draft has to follow.
  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  // Blur is the commit, which covers Enter (it blurs), tabbing out, and
  // clicking away. Unchanged text sends nothing.
  const commit = () => {
    const next = draft.trim();
    setDraft(next);
    if (next === stored) return;
    void onRelabel(plan.id, next === "" ? null : next).then((ok) => {
      // A refused relabel leaves the row's stored value alone, so nothing
      // re-seeds the draft: without this the field keeps showing text the
      // server never accepted, beside an error saying it did not.
      if (!ok) setDraft(stored);
    });
  };

  return (
    <>
      <tr>
        <td>
          <input
            className="label-input"
            type="text"
            placeholder="Add a label"
            aria-label={`Label for plan ${plan.id}`}
            maxLength={MAX_PLAN_LABEL_LENGTH}
            value={draft}
            disabled={busy}
            onChange={(event: Event) => setDraft(inputOf(event).value)}
            onBlur={commit}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Enter") inputOf(event).blur();
              if (event.key === "Escape") setDraft(stored);
            }}
          />
        </td>
        <td>
          <a className="mono" href={plan.url}>
            {plan.id}
          </a>
        </td>
        <td>{formatBytes(plan.size)}</td>
        <td>{new Date(plan.createdAt).toLocaleString()}</td>
        <td>{describeSharing(plan)}</td>
        <td className="actions">
          <button
            type="button"
            className="btn-text"
            disabled={busy}
            onClick={() => replaceInput.current?.click()}
          >
            Replace
          </button>
          {/* The button above is the accessible control; this only carries the
            picker, so it stays out of the tab order. */}
          <input
            ref={replaceInput}
            className="file-input"
            type="file"
            accept=".html,.htm,text/html"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event: Event) => {
              const input = inputOf(event);
              onReplace(plan.id, input.files);
              input.value = "";
            }}
          />
          <button
            type="button"
            className="btn-text"
            disabled={busy}
            onClick={() => setSharing(!sharing)}
            aria-expanded={sharing}
            aria-controls={sharingId}
          >
            Share
          </button>
          <button
            type="button"
            className="btn-text btn-text-clay"
            disabled={busy}
            onClick={() => onDelete(plan.id)}
          >
            Delete
          </button>
        </td>
      </tr>
      {sharing && (
        <tr>
          <td colSpan={6} id={sharingId}>
            <SharingEditor plan={plan} busy={busy} guard={guard} />
          </td>
        </tr>
      )}
    </>
  );
}

export function PlansPanel() {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPlans(await listPlans());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * Without this the browser navigates to any file dropped outside the zone,
   * throwing the dashboard away - the behaviour the drop zone exists to
   * replace. Drops inside the zone bubble up here too, but its handler has
   * already taken the file and a second preventDefault costs nothing.
   *
   * Narrowed to file drags so that dragging text into the other panels' inputs
   * still works.
   */
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  /**
   * Resolves false when `work` threw, so a caller can undo its optimism.
   *
   * Memoised because the sharing editor loads through it from an effect: an
   * identity that changed every render would re-run that effect forever -
   * each run flips `busy`, which rerenders, which rebuilds `guard`.
   */
  const guard = useCallback(
    async (work: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        await work();
        setError(null);
        await refresh();
        return true;
      } catch (cause) {
        // The validator's reason is rendered verbatim so a rejection is
        // actionable rather than a bare 422.
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /** The one HTML file in `files`, or null with the reason already shown. */
  const vet = (files: FileList | null): File | null => {
    const [file, ...rest] = Array.from(files ?? []);
    if (file === undefined) return null;
    if (rest.length > 0) {
      setError("Upload one file at a time.");
      return null;
    }
    if (!isHtml(file)) {
      setError(`${file.name} is not an HTML document.`);
      return null;
    }
    return file;
  };

  const submit = (files: FileList | null) => {
    const file = vet(files);
    // Always private. The dashboard never sends `visibility=code`: it uploads,
    // then mints a code from the row's Share editor, which is the one place a
    // plaintext code is ever revealed.
    if (file !== null) void guard(() => uploadPlan(file, "private"));
  };

  const replace = (id: string, files: FileList | null) => {
    const file = vet(files);
    if (file !== null) void guard(() => replacePlan(id, file));
  };

  return (
    <section className="card">
      <h2 className="card-title">Plans</h2>
      <p className="muted">
        Upload a standalone HTML document. External scripts, stylesheets,
        images, fonts, and iframes are all refused. A new plan is private - use{" "}
        <strong>Share</strong> on its row to open it up.
      </p>
      <label
        className={dragging ? "dropzone is-dragging" : "dropzone"}
        htmlFor="plan-file"
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          if (event.dataTransfer !== null)
            event.dataTransfer.dropEffect = "copy";
          if (!busy) setDragging(true);
        }}
        onDragLeave={(event: DragEvent) => {
          // Children fire their own dragleave as the pointer crosses them; only
          // a departure from the zone itself counts.
          const next = event.relatedTarget;
          const zone = event.currentTarget;
          if (
            next instanceof Node &&
            zone instanceof Node &&
            zone.contains(next)
          )
            return;
          setDragging(false);
        }}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          setDragging(false);
          if (!busy) submit(event.dataTransfer?.files ?? null);
        }}
      >
        <span className="btn-ivory">Choose a file</span>
        <span className="muted">or drop one here</span>
        <input
          id="plan-file"
          className="file-input"
          type="file"
          accept=".html,.htm,text/html"
          disabled={busy}
          onChange={(event: Event) => {
            // Consume before clearing: `files` is the input's live FileList and
            // `value = ""` empties it. The reset still has to happen, or
            // re-picking the same file fires no second change event.
            const input = inputOf(event);
            submit(input.files);
            input.value = "";
          }}
        />
      </label>
      {error !== null && <p className="error">{error}</p>}
      {plans.length === 0 ? (
        <p className="empty" style={{ marginTop: "24px" }}>
          No plans yet.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Id</th>
              <th>Size</th>
              <th>Created</th>
              <th>Sharing</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.map((item) => (
              <PlanRow
                key={item.id}
                plan={item}
                busy={busy}
                guard={guard}
                onRelabel={(id, label) => guard(() => relabelPlan(id, label))}
                onReplace={replace}
                onDelete={(id) => void guard(() => deletePlan(id))}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
