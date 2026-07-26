import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { authClient } from "../client/auth.ts";
import { Hydrated, SiteFrame } from "../client/Chrome.tsx";
import { Dashboard } from "../client/Dashboard.tsx";

export const Route = createFileRoute("/dashboard")({
  component: () => (
    <Hydrated>
      <DashboardPage />
    </Hydrated>
  ),
});

/**
 * Signed-in only. The guard runs in the browser because the session lives
 * behind the auth client, and it is navigation rather than access control:
 * every route this page calls authorises the session server-side.
 */
function DashboardPage() {
  const { data: session, isPending } = authClient().useSession();
  const navigate = useNavigate();
  const handle = session?.user.name ?? null;

  useEffect(() => {
    if (!isPending && handle === null)
      void navigate({ to: "/", replace: true });
  }, [isPending, handle, navigate]);

  return (
    <SiteFrame handle={handle}>
      {handle === null ? (
        <div className="shell hero">
          <p className="muted">Loading…</p>
        </div>
      ) : (
        <Dashboard handle={handle} />
      )}
    </SiteFrame>
  );
}
