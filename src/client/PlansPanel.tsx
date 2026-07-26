import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_PLAN_LABEL_LENGTH } from "../http/plan-label.ts";
import {
  deletePlan,
  listPlans,
  type PlanSummary,
  relabelPlan,
  replacePlan,
  uploadPlan,
} from "./api.ts";

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

interface RowProps {
  plan: PlanSummary;
  busy: boolean;
  onRelabel: (id: string, label: string | null) => Promise<boolean>;
  onReplace: (id: string, files: FileList | null) => void;
  onDelete: (id: string) => void;
}

function PlanRow({ plan, busy, onRelabel, onReplace, onDelete }: RowProps) {
  const stored = plan.label ?? "";
  const [draft, setDraft] = useState(stored);
  const replaceInput = useRef<HTMLInputElement>(null);

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
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
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
          onChange={(event) => {
            onReplace(plan.id, event.target.files);
            event.target.value = "";
          }}
        />
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

  /** Resolves false when `work` threw, so a caller can undo its optimism. */
  const guard = async (work: () => Promise<unknown>): Promise<boolean> => {
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
  };

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
    if (file !== null) void guard(() => uploadPlan(file));
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
        images, fonts, and iframes are all refused.
      </p>
      <label
        className={dragging ? "dropzone is-dragging" : "dropzone"}
        htmlFor="plan-file"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          if (!busy) setDragging(true);
        }}
        onDragLeave={(event) => {
          // Children fire their own dragleave as the pointer crosses them; only
          // a departure from the zone itself counts.
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next))
            return;
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!busy) submit(event.dataTransfer.files);
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
          onChange={(event) => {
            // Consume before clearing: `files` is the input's live FileList and
            // `value = ""` empties it. The reset still has to happen, or
            // re-picking the same file fires no second change event.
            submit(event.target.files);
            event.target.value = "";
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
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.map((item) => (
              <PlanRow
                key={item.id}
                plan={item}
                busy={busy}
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
