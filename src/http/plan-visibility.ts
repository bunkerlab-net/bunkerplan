import { PLAN_VISIBILITIES, type PlanVisibility } from "../limits.ts";

/**
 * What the two routes that set visibility accept, and the one parser that
 * reads them: `?visibility=` on upload, and the body of
 * `PUT /api/plans/:id/sharing`.
 *
 * `"code"` is an upload *intent*, not a stored state: it stores `private` and
 * mints a share code in the same insert, returning the plaintext once in the
 * 201 body. Keeping it out of the stored enum is what stops a third visibility
 * from leaking into the column, the dashboard, and the published document.
 */
export type UploadVisibility = PlanVisibility | "code";

export type VisibilityResult =
  | {
      ok: true;
      /** What the caller asked for, `"code"` included. */
      requested: UploadVisibility;
      /** What that means for the column, which has no `"code"`. */
      stored: PlanVisibility;
    }
  | { ok: false; reason: string };

export interface VisibilityOptions {
  /** Whether the `"code"` upload intent is one of the accepted values. */
  code: boolean;
  /**
   * What no value at all means. Absent `?visibility=` means private: the issue
   * this implements asks for plans to be private unless their owner says
   * otherwise, and a default that leaked in the other direction would be
   * silent. A sharing body that names nothing is a client mistake rather than a
   * request to make the plan private, so that caller passes `"refuse"`.
   */
  absent: PlanVisibility | "refuse";
  /**
   * Where the value is: a bare one, as a query parameter is, or the
   * `visibility` field of a parsed JSON body.
   *
   * Named rather than sniffed. An object is never a legal visibility, so the
   * two could be told apart - but then a body that is a bare JSON string would
   * read as a visibility, and `PUT .../sharing` refuses one today.
   */
  from: "value" | "body";
}

/**
 * Reads a requested visibility, refusing anything outside the accepted set.
 *
 * The accepted set is derived from `PLAN_VISIBILITIES`, so neither the check
 * nor the refusal message can name a value the column does not hold.
 */
export function parseVisibility(
  raw: unknown,
  options: VisibilityOptions,
): VisibilityResult {
  const accepted: readonly UploadVisibility[] = options.code
    ? [...PLAN_VISIBILITIES, "code"]
    : PLAN_VISIBILITIES;
  // Both spellings come off the same tuple, so a refusal cannot name a value
  // the column does not hold, and the intent is appended where it is accepted.
  const reason = options.code
    ? `visibility must be ${PLAN_VISIBILITIES.join(", ")}, or code`
    : `visibility must be ${PLAN_VISIBILITIES.join(" or ")}`;

  const value =
    options.from === "body"
      ? typeof raw === "object" && raw !== null && "visibility" in raw
        ? raw.visibility
        : undefined
      : raw;

  if (value === null || value === undefined) {
    return options.absent === "refuse"
      ? { ok: false, reason }
      : { ok: true, requested: options.absent, stored: options.absent };
  }

  for (const candidate of accepted) {
    if (value === candidate) {
      return {
        ok: true,
        requested: candidate,
        // `"code"` is the only one of these that is an intent rather than a
        // column value: it stores `private` and mints a code beside it. Every
        // real visibility stores itself, which is what keeps this derived from
        // the tuple - naming `public` here instead would quietly store a third
        // visibility as `private` the day one is added.
        stored: candidate === "code" ? "private" : candidate,
      };
    }
  }
  return { ok: false, reason };
}
