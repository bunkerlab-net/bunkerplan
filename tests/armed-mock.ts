import { afterEach, beforeEach } from "bun:test";

/**
 * Keeps a module stub from answering for files that never asked for it.
 *
 * `mock.module` is process-global and cannot be unregistered, and its factory
 * runs once - so under a plain `bun test`, where every file shares one module
 * registry, a stub installed by one file stands in for every file after it.
 * That is not hypothetical: a mocked `@aws-sdk/client-s3` replaced the real
 * client inside the MinIO contract suite, and the integration tests went on
 * "passing" against an in-memory array until their assertions caught it.
 *
 * `--isolate` hides the problem by giving each file its own registry. Relying
 * on that makes the bare command a trap, so the stubs do not rely on it: the
 * registration stays for the whole run, but each stubbed export checks an arm
 * on every call and forwards to the real module unless the file currently
 * running armed it.
 *
 * A suite arms itself by calling the `use...` function its stub exports, which
 * registers the hooks below in that suite's own scope. A file that does not
 * call it gets the real module, whatever ran before it.
 */
export interface Arm {
  on: boolean;
}

export function armWhileFileRuns(arm: Arm, reset: () => void): void {
  beforeEach(() => {
    arm.on = true;
    reset();
  });
  afterEach(() => {
    arm.on = false;
    reset();
  });
}
