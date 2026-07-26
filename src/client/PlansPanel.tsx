import { useCallback, useEffect, useState } from "react";
import { deletePlan, listPlans, type PlanSummary, uploadPlan } from "./api.ts";

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
  onDelete: (id: string) => void;
}

function PlanRow({ plan, busy, onDelete }: RowProps) {
  return (
    <tr>
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

  const guard = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      setError(null);
      await refresh();
    } catch (cause) {
      // The validator's reason is rendered verbatim so a rejection is
      // actionable rather than a bare 422.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = (files: FileList | null) => {
    const [file, ...rest] = Array.from(files ?? []);
    if (file === undefined) return;
    if (rest.length > 0) {
      setError("Upload one file at a time.");
      return;
    }
    if (!isHtml(file)) {
      setError(`${file.name} is not an HTML document.`);
      return;
    }
    void guard(() => uploadPlan(file));
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
                onDelete={(id) => void guard(() => deletePlan(id))}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
