/**
 * Wire-visible ceilings and enums shared across layers.
 *
 * A leaf module: it imports nothing, so src/http, src/api, src/html,
 * src/services, and the client bundle can all name the same number without
 * importing each other. Everything here is part of the public API surface -
 * the OpenAPI document quotes these values, so changing one is a contract
 * change, not a tuning knob.
 */

/** Most accounts one grant request may name. */
export const MAX_GRANTS_PER_REQUEST = 50;

/**
 * Body cap for grant requests: room for the ceiling above at a generous
 * identifier length, plus the JSON envelope.
 */
export const MAX_ACCOUNT_LIST_BYTES = MAX_GRANTS_PER_REQUEST * 66 + 64;

/** Owner-facing plan label length, measured after trimming. */
export const MAX_PLAN_LABEL_LENGTH = 100;

/** Body cap for relabel requests. */
export const MAX_LABEL_BODY_BYTES = 4096;

/**
 * Rows fetched per `PlanRepo.listByUser` call. Fixed, so it cannot drift with
 * the plan quota - see the note on `listByUser` in src/services/types.ts.
 */
export const PLAN_PAGE_SIZE = 500;

/**
 * Most plans one Cloudflare Workers invocation may remove.
 *
 * A subrequest figure, not a storage one. Deleting an account sweeps its
 * objects before the row cascade (`sweepAccountObjects` in
 * src/auth/instance.ts) and each plan costs two subrequests - the R2 delete
 * and the D1 delete - of the 1000 an invocation may make. The remainder is
 * left for the listing queries and for the deletion Better Auth performs
 * around the hook.
 *
 * Read twice, which is the point of one constant: `MAX_PLANS_PER_USER` is
 * refused above it on Workers, so an account cannot grow past what one
 * deletion can finish, and the sweep stops at it and asks to be retried, so
 * an account that grew under an older, higher quota is still deletable.
 *
 * Self-hosted there is no per-request budget and neither rule applies: Node
 * and Bun make ordinary calls in a process nothing is counting.
 */
export const WORKERS_MAX_PLANS_PER_USER = 400;

/**
 * Most refusal reasons one validation response carries. The HTML gate stops
 * collecting past this; the Error schema's `errors` array is capped to match.
 */
export const MAX_FINDINGS = 10;

/**
 * The one visibility enum. The Zod schemas, the request parsers, and the
 * database CHECK constraints all derive from this tuple.
 */
export const PLAN_VISIBILITIES = ["public", "private"] as const;

/**
 * The visibility enum as a type. Beside the tuple it derives from, so the
 * database schema files can name it without importing the service contracts.
 */
export type PlanVisibility = (typeof PLAN_VISIBILITIES)[number];
