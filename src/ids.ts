import { customAlphabet } from "nanoid";

/**
 * Plan ids are alphanumeric only. nanoid's default alphabet includes `-` and
 * `_`, which survive a URL but get mangled by everything that autolinks: chat
 * clients clip a trailing `-`, `_` vanishes under underline styling, and both
 * break a double-click word selection. 62 symbols still leaves ~5.95 bits per
 * character.
 */
const planAlphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const generate = customAlphabet(planAlphabet);

/** No 0/1/i/l/o lookalikes — handles get read aloud and retyped. */
const handleAlphabet = "23456789abcdefghjkmnpqrstuvwxyz";

export const newUserHandle = customAlphabet(handleAlphabet, 10);

/**
 * Static routes out-rank the `$planId` route, so an id colliding with one would
 * be silently unreachable. At the default length this branch is never taken,
 * but PLAN_ID_LENGTH can be lowered far enough to make short ids plausible.
 */
const RESERVED: Record<string, true> = {
  api: true,
  assets: true,
  docs: true,
  healthz: true,
  favicon: true,
};

export function newPlanId(length: number): string {
  let id = generate(length);
  while (RESERVED[id.toLowerCase()] === true) id = generate(length);
  return id;
}
