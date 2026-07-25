import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { App } from "../client/App.tsx";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  // The auth client needs `window.location.origin`, so the whole app renders
  // only after hydration. Nothing below this point runs during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <main className="shell">
        <p className="muted" style={{ padding: "100px 0" }}>
          Loading…
        </p>
      </main>
    );
  }
  return <App />;
}
