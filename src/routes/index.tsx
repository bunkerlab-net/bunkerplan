import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Dashboard } from "../client/Dashboard.tsx";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  // The auth client needs `window.location.origin`, so the dashboard only
  // renders after hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <main>
      <h1>BunkerPlan</h1>
      <p className="lede">
        Upload a standalone HTML document; get a public URL. Passkeys only.
      </p>
      {mounted ? <Dashboard /> : <p className="muted">Loading…</p>}
    </main>
  );
}
