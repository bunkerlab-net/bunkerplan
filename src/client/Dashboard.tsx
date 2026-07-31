import { ApiKeysPanel } from "./ApiKeysPanel.tsx";
import { DangerZone } from "./DangerZone.tsx";
import { PasskeysPanel } from "./PasskeysPanel.tsx";
import { PlansPanel } from "./PlansPanel.tsx";

interface DashboardProps {
  handle: string;
  /**
   * Pinned by `DangerZone`: which account a delete is allowed to remove.
   *
   * Null while the session is still resolving, which `DangerZone` treats as
   * nothing to compare against rather than as an id that cannot match.
   */
  userId: string | null;
}

export function Dashboard({ handle, userId }: DashboardProps) {
  return (
    <div className="shell">
      <div className="hero">
        <h1 className="page-title">Your plans, keys, and passkeys.</h1>
        <p className="lede muted">
          Uploads are private: only you can open one until you share it with a
          code, with named accounts, or with anyone holding the URL. Replacing
          or deleting a plan reuses or retires its URL, and making a public plan
          private takes effect straight away.
        </p>
        <p className="lede">
          You are <span className="mono">{handle}</span>. That is your handle -
          give it to anyone who wants to share a plan with you, and ask for
          theirs to share one of yours.
        </p>
      </div>
      <div className="stack">
        <PlansPanel />
        <ApiKeysPanel />
        <PasskeysPanel />
        <DangerZone handle={handle} userId={userId} />
      </div>
    </div>
  );
}
