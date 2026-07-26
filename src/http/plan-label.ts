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
 * Characters a label must not carry.
 *
 * `\p{Cc}` covers NUL and the rest of the C0/C1 controls. A NUL is not merely
 * untidy: Postgres rejects one in a `text` column and the throw surfaces as a
 * 500, while SQLite stores it happily, so the same request behaves differently
 * on the two supported runtimes.
 *
 * The rest are the bidi overrides and isolates, which reorder the characters
 * around them when rendered and so let one label impersonate another in a
 * list. Deliberately NOT all of `\p{Cf}`: that would also take the zero-width
 * joiner, which ordinary emoji and several scripts need.
 */
const FORBIDDEN = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

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
  if (FORBIDDEN.test(label)) {
    return {
      ok: false,
      reason: "label contains control or text-direction characters",
    };
  }

  return { ok: true, label };
}
