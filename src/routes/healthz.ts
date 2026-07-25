import { createFileRoute } from "@tanstack/react-router";
import { getServices } from "#runtime";

type CheckName = "storage" | "db" | "kv";

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: async () => {
        const { storage, db, kv, logger } = await getServices();
        const names: CheckName[] = ["storage", "db", "kv"];
        const settled = await Promise.allSettled([
          storage.probe(),
          db.probe(),
          kv.probe(),
        ]);

        const checks: Record<string, string> = {};
        let ok = true;
        for (const [index, name] of names.entries()) {
          const result = settled[index];
          if (result?.status === "fulfilled") {
            checks[name] = "ok";
            continue;
          }
          ok = false;
          checks[name] = "error";
          // The reason goes to the log and never into the response body: a
          // driver error can embed the connection string, and /healthz is
          // unauthenticated. Logs are the operator's own trust boundary and
          // the only place a 503 can actually be diagnosed, so the full error
          // belongs there.
          logger.error({ err: result?.reason, check: name }, "probe failed");
        }

        return Response.json(
          { status: ok ? "ok" : "error", checks },
          { status: ok ? 200 : 503 },
        );
      },
    },
  },
});
