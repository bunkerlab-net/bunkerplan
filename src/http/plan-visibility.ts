import type { PlanVisibility } from "../services/types.ts";

/**
 * What the `?visibility=` upload parameter accepts.
 *
 * `"code"` is an upload *intent*, not a stored state: it stores `private` and
 * mints a share code in the same insert, returning the plaintext once in the
 * 201 body. Keeping it out of the stored enum is what stops a third visibility
 * from leaking into the column, the dashboard, and the published document.
 */
export type UploadVisibility = "public" | "private" | "code";

export type UploadVisibilityResult =
  | { ok: true; requested: UploadVisibility }
  | { ok: false; reason: string };

export type PlanVisibilityResult =
  | { ok: true; visibility: PlanVisibility }
  | { ok: false; reason: string };

/**
 * Reads `?visibility=`. Absent means private: the issue this implements asks
 * for plans to be private unless their owner says otherwise, and a default
 * that leaked in the other direction would be silent.
 */
export function parseUploadVisibility(
  raw: string | null,
): UploadVisibilityResult {
  if (raw === null) return { ok: true, requested: "private" };
  if (raw === "public" || raw === "private" || raw === "code") {
    return { ok: true, requested: raw };
  }
  return { ok: false, reason: "visibility must be public, private, or code" };
}

/** The value that reaches the `visibility` column. `"code"` stores `private`. */
export function storedVisibility(requested: UploadVisibility): PlanVisibility {
  return requested === "public" ? "public" : "private";
}

/**
 * The body of `PUT /api/plans/:id/sharing`, which has no `"code"` intent:
 * giving an existing plan a code is `POST /api/plans/:id/share-code`, because
 * that is the request that hands back a plaintext code.
 */
export function parsePlanVisibility(raw: unknown): PlanVisibilityResult {
  if (raw === "public" || raw === "private") {
    return { ok: true, visibility: raw };
  }
  return { ok: false, reason: "visibility must be public or private" };
}
