import type { PlanRepo } from "../src/services/types.ts";

/**
 * The sharing half of `PlanRepo`, refusing everything.
 *
 * Four unit suites exercise a handler that has nothing to do with sharing -
 * create, relabel, the health probe, and the edge cases around replace - but
 * `PlanRepo` is one interface, so each of them still has to name all seven
 * methods to satisfy the type. Spreading this is what keeps a new sharing
 * method from being four identical edits, and it keeps each fake's own body
 * down to the methods that suite actually cares about.
 *
 * Every answer here is the negative one, so a handler that unexpectedly
 * reaches into sharing gets "no such plan" rather than a convenient success
 * that would let a test pass for the wrong reason. A suite that means to
 * exercise one of these overrides it after the spread.
 *
 * A suite that wants a repository which actually behaves - ownership, the
 * quota, the "a public plan never carries a code" invariant - wants
 * `memoryPlans` in tests/fakes.ts instead. This is for the fakes that are
 * deliberately inert.
 */
export const basePlanRepoStub = {
  findAccess: async () => null,
  hasGrant: async () => false,
  setVisibility: async () => false,
  setShareCodeHash: async () => false,
  listGrantHandles: async () => null,
  grantByHandle: async () => "no-plan",
  revokeByHandle: async () => false,
} satisfies Pick<
  PlanRepo,
  | "findAccess"
  | "hasGrant"
  | "setVisibility"
  | "setShareCodeHash"
  | "listGrantHandles"
  | "grantByHandle"
  | "revokeByHandle"
>;
