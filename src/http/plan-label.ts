/**
 * Plan labels are owner-facing text. They are not part of the stored object,
 * not part of the public URL, and not unique - the id remains the identity.
 * The only constraint that matters is that a label stays short enough to read
 * in a dashboard table cell.
 */
export const MAX_PLAN_LABEL_LENGTH = 100;

export type PlanLabelResult =
  | { ok: true; label: string | null }
  | { ok: false; reason: string };

/**
 * Normalises a caller-supplied label. `null` in means the caller sent none;
 * blank means the owner cleared the field. Both store `null`, so an unlabelled
 * plan and a plan labelled `"   "` are the same thing.
 */
export function parsePlanLabel(raw: string | null): PlanLabelResult {
  if (raw === null) return { ok: true, label: null };

  const label = raw.trim();
  if (label === "") return { ok: true, label: null };
  if (label.length > MAX_PLAN_LABEL_LENGTH) {
    return {
      ok: false,
      reason: `label exceeds ${MAX_PLAN_LABEL_LENGTH} characters`,
    };
  }

  return { ok: true, label };
}
