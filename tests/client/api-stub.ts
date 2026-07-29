import "./dom-env.ts";
import { mock } from "bun:test";
import type {
  GrantResult,
  PlanSharing,
  PlanSummary,
} from "../../src/client/api.ts";
import * as real from "../../src/client/api.ts";
import { type Arm, armWhileFileRuns } from "../armed-mock.ts";

/**
 * The plans API, replaced.
 *
 * `PlansPanel` is a state machine over nine calls - list, upload, replace,
 * relabel, delete, and the four sharing ones - and the behaviour worth pinning
 * is what it does with each answer: which control goes busy, what the error
 * line says, whether the list is refetched. Swapping the module is what makes
 * a refusal or a throw as cheap to stage as a success.
 *
 * src/client/api.ts is covered on its own by api.test.ts, which stubs `fetch`
 * one level down rather than using this.
 */

export interface Recorded {
  method: string;
  args: unknown[];
}

/** Every call the panel made, in order, so a suite can assert on absence too. */
export const calls: Recorded[] = [];

type Handler = (...args: never[]) => unknown;

interface Api {
  listPlans: Handler;
  uploadPlan: Handler;
  relabelPlan: Handler;
  deletePlan: Handler;
  replacePlan: Handler;
  getSharing: Handler;
  setVisibility: Handler;
  rotateShareCode: Handler;
  clearShareCode: Handler;
  addGrants: Handler;
  removeGrant: Handler;
  unlockPlan: Handler;
}

const NAMES = [
  "listPlans",
  "uploadPlan",
  "relabelPlan",
  "deletePlan",
  "replacePlan",
  "getSharing",
  "setVisibility",
  "rotateShareCode",
  "clearShareCode",
  "addGrants",
  "removeGrant",
  "unlockPlan",
] as const satisfies ReadonlyArray<keyof Api>;

/**
 * An unstubbed call throws rather than resolving to `undefined`: a panel that
 * reaches for a call the test never staged has done something the test did not
 * mean, and a convenient empty answer would hide it.
 */
function blank(): Api {
  return Object.fromEntries(
    NAMES.map((name) => [
      name,
      () => {
        throw new Error(`${name} was called but this test did not stub it`);
      },
    ]),
  ) as unknown as Api;
}

/** Mutated in place, so the stubbed module keeps pointing at it. */
export const api: Api = blank();

const arm: Arm = { on: false };

/**
 * Captured before the registration below, and deliberately a copy: the live
 * namespace object is what `mock.module` replaces, so reading through it
 * afterwards would route the fallback straight back into this stub.
 */
const passthrough = { ...real } as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

mock.module("../../src/client/api.ts", () =>
  Object.fromEntries(
    NAMES.map((name) => [
      name,
      async (...args: unknown[]) => {
        // Unarmed means some other file imported this stub earlier and the
        // registration outlived it. Forward to the real module - api.test.ts
        // exercises exactly that, and it must get the real `fetch` wrappers.
        if (!arm.on) {
          return await passthrough[name]?.(...args);
        }
        calls.push({ method: name, args });
        return await (api[name] as (...rest: unknown[]) => unknown)(...args);
      },
    ]),
  ),
);

/** Arms the stub for the calling suite. Without it, the real module answers. */
export function useApiStub(): void {
  armWhileFileRuns(arm, () => {
    Object.assign(api, blank());
    calls.length = 0;
  });
}

/** How many times `method` was called. */
export function countOf(method: keyof Api): number {
  return calls.filter((call) => call.method === method).length;
}

let nextId = 0;

export function plan(over: Partial<PlanSummary> = {}): PlanSummary {
  nextId += 1;
  const id = over.id ?? `plan${nextId}`;
  return {
    id,
    url: `https://plans.test/p/${id}`,
    label: null,
    size: 2048,
    createdAt: "2026-01-02T03:04:05.000Z",
    visibility: "private",
    hasShareCode: false,
    ...over,
  };
}

export function sharing(over: Partial<PlanSharing> = {}): PlanSharing {
  return { visibility: "private", hasShareCode: false, grants: [], ...over };
}

export function grantResult(over: Partial<GrantResult> = {}): GrantResult {
  return { granted: [], unknown: [], failed: [], ...over };
}
