import { createFileRoute } from "@tanstack/react-router";
import { getServices } from "#runtime";
import { deletePlan } from "../../http/delete-plan.ts";
import { resolveWriteUserId } from "../../http/require-user.ts";

export const Route = createFileRoute("/api/plans/$id")({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        const { auth, db, logger, storage } = await getServices();

        const userId = await resolveWriteUserId(auth, request);
        if (userId === null) {
          return Response.json(
            { error: "authentication required" },
            { status: 401 },
          );
        }

        return await deletePlan(storage, db.plans, logger, params.id, userId);
      },
    },
  },
});
