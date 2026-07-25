import { useCallback, useEffect, useState } from "react";
import { deletePlan, listPlans, type PlanSummary, uploadPlan } from "./api.ts";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
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

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      await uploadPlan(file);
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

  const onDelete = async (id: string) => {
    setBusy(true);
    try {
      await deletePlan(id);
      setError(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Plans</h2>
      <div className="row">
        <input
          type="file"
          accept=".html,.htm,text/html"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void onUpload(file);
          }}
        />
        <span className="muted">Standalone HTML only.</span>
      </div>
      {error !== null && <p className="error">{error}</p>}
      {plans.length === 0 ? (
        <p className="empty">No plans yet.</p>
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
              <tr key={item.id}>
                <td>
                  <a className="mono" href={item.url}>
                    {item.id}
                  </a>
                </td>
                <td>{formatBytes(item.size)}</td>
                <td>{new Date(item.createdAt).toLocaleString()}</td>
                <td>
                  <button
                    type="button"
                    className="destructive"
                    disabled={busy}
                    onClick={() => void onDelete(item.id)}
                  >
                    Delete
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
