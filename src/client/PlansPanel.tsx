import { useCallback, useEffect, useState } from "react";
import { deletePlan, listPlans, type PlanSummary, uploadPlan } from "./api.ts";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
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

  return (
    <section className="card">
      <h2 className="card-title">Plans</h2>
      <p className="muted">
        Upload a standalone HTML document. External scripts, stylesheets,
        images, fonts and iframes are all refused.
      </p>
      <div className="row" style={{ marginTop: "16px" }}>
        <label className="btn-ivory" htmlFor="plan-file">
          Choose a file
        </label>
        <input
          id="plan-file"
          className="file-input"
          type="file"
          accept=".html,.htm,text/html"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void guard(() => uploadPlan(file));
          }}
        />
      </div>
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
