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
  // Against the real module as well as `Api`: this list is hand-written, so
  // without `keyof typeof real` a renamed export keeps compiling here and the
  // passthrough below quietly forwards to nothing.
] as const satisfies ReadonlyArray<keyof Api & keyof typeof real>;

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

/** Empty while `NAMES` is complete, and the export's own name once it is not. */
type Unmocked = Exclude<keyof typeof real, (typeof NAMES)[number]>;

/**
 * Captured before the registration below, and deliberately a copy: the live
 * namespace object is what `mock.module` replaces, so reading through it
 * afterwards would route the fallback straight back into this stub.
 *
 * The `satisfies` is the other half of `NAMES`, matching auth-stub.ts. That
 * list rejects a name that has gone; `Record<Unmocked, never>` is satisfiable
 * only while nothing has arrived, so an export added to src/client/api.ts fails
 * this file and names itself rather than going unstubbed.
 */
const passthrough = { ...real } satisfies Record<
  Unmocked,
  never
> as unknown as Record<string, (...args: unknown[]) => unknown>;

mock.module("../../src/client/api.ts", () =>
  Object.fromEntries(
    NAMES.map((name) => [
      name,
      async (...args: unknown[]) => {
        // Unarmed means some other file imported this stub earlier and the
        // registration outlived it. Forward to the real module - api.test.ts
        // exercises exactly that, and it must get the real `fetch` wrappers.
        if (!arm.on) {
          const forward = passthrough[name];
          if (forward === undefined) {
            throw new Error(`src/client/api.ts exports no ${name}`);
          }
          return await forward(...args);
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
    // Reset with the rest: left running, the ids a test sees depend on how
    // many plans every test before it happened to build.
    nextId = 0;
  });
}

/** How many times `method` was called. */
export function countOf(method: keyof Api): number {
  return calls.filter((call) => call.method === method).length;
}

/**
 * Arguments of the first `method` call; throws if there was none.
 *
 * `[0]?.args` compares `undefined` against the expected array, so no call reads
 * as the wrong arguments. Those are different failures.
 */
export function argsOf(method: keyof Api): unknown[] {
  const call = calls.find((entry) => entry.method === method);
  if (call === undefined) {
    throw new Error(`no ${String(method)} call was made`);
  }
  return call.args;
}

let nextId = 0;

export function plan(over: Partial<PlanSummary> = {}): PlanSummary {
  // Spent only when one is needed. Advancing it for an explicit id would make
  // the generated sequence depend on how many named plans a test also made.
  if (over.id === undefined) nextId += 1;
  const id = over.id ?? `plan${nextId}`;
  return {
    id,
    url: `https://plans.test/p/${id}`,
    label: null,
    size: 2048,
    createdAt: "2026-01-02T03:04:05.000Z",
    visibility: "private",
    hasShareCode: false,
    hasGrants: false,
    ...over,
  };
}

export function sharing(over: Partial<PlanSharing> = {}): PlanSharing {
  return { visibility: "private", hasShareCode: false, grants: [], ...over };
}

export function grantResult(over: Partial<GrantResult> = {}): GrantResult {
  return { granted: [], unknown: [], failed: [], ...over };
}
