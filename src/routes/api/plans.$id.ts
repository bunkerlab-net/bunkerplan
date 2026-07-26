import { createFileRoute } from "@tanstack/react-router";
import { getServices } from "#runtime";
import { deletePlan } from "../../http/delete-plan.ts";
import { relabelPlan } from "../../http/relabel-plan.ts";
import { replacePlan } from "../../http/replace-plan.ts";
import {
  resolveSessionUserId,
  resolveWriteUserId,
} from "../../http/require-user.ts";
import { checkUploadRate } from "../../http/upload-rate-limit.ts";

function unauthorised() {
  return Response.json({ error: "authentication required" }, { status: 401 });
}

export const Route = createFileRoute("/api/plans/$id")({
  server: {
    handlers: {
      // Replaces the document behind an id the caller already owns, so a plan
      // can be revised without its URL changing. Owner-scoped: an id belonging
      // to another account 404s and its object is never touched.
      PUT: async ({ request, params }) => {
        const { auth, config, db, logger, storage } = await getServices();

        const userId = await resolveWriteUserId(auth, request);
        if (userId === null) return unauthorised();

        const limited = await checkUploadRate(
          db.uploadRateLimits,
          config,
          userId,
        );
        if (limited !== null) return limited;

        return await replacePlan(
          storage,
          db.plans,
          logger,
          request,
          params.id,
          userId,
          config,
        );
      },

      // Session-only, unlike PUT and DELETE: an API key authorises upload and
      // delete, and the label it can set is the one it supplies on upload.
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
