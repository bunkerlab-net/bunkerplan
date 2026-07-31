import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";

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
  /*
   * Armed from setup rather than from the first test, so a suite that reaches
   * the module in its own `beforeAll` - to seed something every test then
   * reads - gets the stub there too, and not the real module in setup and the
   * stub afterwards.
   *
   * Teardown is the one gap, and it is a registration-order fact rather than
   * an oversight: hooks run in the order they were registered, and a caller
   * that calls this first has its own `afterAll` run after the disarm below.
   * Nothing needs the stub in teardown today. A suite that did would have to
   * arm after registering that hook, and the disarm has to stay somewhere -
   * an arm left on outlives the file and answers for the next one.
   */
  beforeAll(() => {
    arm.on = true;
  });
  afterAll(() => {
    arm.on = false;
    reset();
  });

  // The reset stays per test, because that is what it is for: a stub one test
  // pointed somewhere must not still point there in the next.
  beforeEach(reset);
  afterEach(reset);
}
