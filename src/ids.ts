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

/**
 * Plans are served from `/p/{id}` (src/routes/p.$planId.tsx), never from the
 * root, so no reserved-word list is needed: an id cannot collide with an app
 * route, and a route added later cannot shadow an already-published plan.
 *
 * That holds only while `/p/` stays exclusively the plan namespace. A static
 * route declared under it - `/p/new` - would out-rank `/p/$planId` and shadow
 * that id, which is the very failure this move exists to remove. Put app
 * routes anywhere else.
 */
export const newPlanId = customAlphabet(planAlphabet);

/**
 * Whether a string is an id `newPlanId` could have issued.
 *
 * `/p/{planId}` turns a URL path segment into an object key, and the router
 * percent-decodes it first, so a segment carrying `%2F` would otherwise reach
 * storage as a real `/`. The character class is the generator's own alphabet,
 * so the two cannot drift apart.
 *
 * The length bound is deliberately loose rather than `config.planIdLength`: an
 * operator who raises or lowers that setting must not orphan ids already
 * issued under the previous one.
 */
const PLAN_ID_PATTERN = new RegExp(`^[${planAlphabet}]{1,64}$`);

export function isPlanId(value: string): boolean {
  return PLAN_ID_PATTERN.test(value);
}

/** No 0/1/i/l/o lookalikes - handles get read aloud and retyped. */
const handleAlphabet = "23456789abcdefghjkmnpqrstuvwxyz";

export const newUserHandle = customAlphabet(handleAlphabet, 10);
