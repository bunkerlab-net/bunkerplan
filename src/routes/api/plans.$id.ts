import { createFileRoute } from "@tanstack/react-router";
import { getServices } from "#runtime";
import { deletePlan } from "../../http/delete-plan.ts";
import { relabelPlan } from "../../http/relabel-plan.ts";
import {
  resolveSessionUserId,
  resolveWriteUserId,
} from "../../http/require-user.ts";

function unauthorised() {
  return Response.json({ error: "authentication required" }, { status: 401 });
}

export const Route = createFileRoute("/api/plans/$id")({
  server: {
    handlers: {
      // Session-only, matching GET /api/plans: an API key authorises upload
      // and delete, and the label it can set is the one it supplies on upload.
      PATCH: async ({ request, params }) => {
        const { auth, db } = await getServices();

        const userId = await resolveSessionUserId(auth, request);
        if (userId === null) return unauthorised();

        return await relabelPlan(db.plans, request, params.id, userId);
      },

      DELETE: async ({ request, params }) => {
        const { auth, db, logger, storage } = await getServices();

        const userId = await resolveWriteUserId(auth, request);
        if (userId === null) return unauthorised();

        return await deletePlan(storage, db.plans, logger, params.id, userId);
      },
    },
  },
});
