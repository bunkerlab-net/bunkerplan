import { ApiKeysPanel } from "./ApiKeysPanel.tsx";
import { DangerZone } from "./DangerZone.tsx";
import { PasskeysPanel } from "./PasskeysPanel.tsx";
import { PlansPanel } from "./PlansPanel.tsx";

interface DashboardProps {
  handle: string;
}

export function Dashboard({ handle }: DashboardProps) {
  return (
    <div className="shell">
      <div className="hero">
        <h1 className="page-title">Your plans, keys and passkeys.</h1>
        <p className="lede muted">
          Uploads are public to anyone holding the URL and unlisted otherwise.
          Deleting a plan takes its URL out of service, though a cached copy can
          survive for up to five minutes.
        </p>
      </div>
      <div className="stack">
        <PlansPanel />
        <ApiKeysPanel />
        <PasskeysPanel />
        <DangerZone handle={handle} />
      </div>
    </div>
  );
}
