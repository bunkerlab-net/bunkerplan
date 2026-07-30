import { describe, expect, mock, test } from "bun:test";
import realPg from "pg";
import { type Arm, armWhileFileRuns } from "./armed-mock.ts";

/**
 * What the health probe does with its pool connection.
 *
 * tests/drivers/db.postgres.test.ts runs the repository contract against a
 * real server and stays the authority on behaviour. It cannot reach this: the
 * case only exists when the server has stopped answering, so the probe's
 * deadline expires with a query still in flight, and what matters is whether
 * the connection goes back to a pool of ten or is thrown away.
 *
 * `pg` is stubbed rather than reached. A real server would have to be wedged
 * to produce the hang, and the claim is about the driver's own bookkeeping
 * either way.
 */

interface Released {
  destroyed: boolean;
}

const released: Released[] = [];
const asked: string[] = [];
let connects = 0;

const answer = async () => ({ rows: [{ "?column?": 1 }] });

/** Settles the next `connect()`, replaced per test. */
let connect: () => Promise<unknown> = async () => stubClient();
/** Settles the next `query()`, replaced per test. */
let respond: () => Promise<unknown> = answer;

/**
 * The half of `pg`'s client this driver touches.
 *
 * A destroyed connection takes its in-flight query down with it, so the stub
 * rejects one the way the real client does. Without that, an abandoned probe
 * would hang here and the suite would pass on a promise nobody settled.
 */
function stubClient() {
  let fail: ((cause: Error) => void) | null = null;
  return {
    query: (text: string) => {
      asked.push(text);
      return Promise.race([
        respond(),
        new Promise((_, reject) => {
          fail = reject;
        }),
      ]);
    },
    release: (cause?: Error) => {
      released.push({ destroyed: cause !== undefined });
      if (cause !== undefined) fail?.(cause);
    },
  };
}

const arm: Arm = { on: false };

/**
 * A real pool that answers from the stub only while armed.
 *
 * `mock.module` cannot be unregistered and its factory runs once, so the trap
 * has to decide per call rather than per registration: unarmed, every other
 * file in the process - the Postgres contract suite included - gets the real
 * `connect`. Subclassing keeps that path genuinely untouched, and a pool that
 * is never connected to opens no sockets, so the armed side costs nothing.
 *
 * Only the argument-less form is the probe's. `pool.query()` connects with a
 * callback internally, so intercepting that one would strand every real query
 * on a promise nobody reads - the contract suite's included.
 */
class PoolTrap extends realPg.Pool {
  override connect(): Promise<realPg.PoolClient>;
  override connect(
    callback: (
      err: Error | undefined,
      client: realPg.PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): void;
  override connect(
    callback?: (
      err: Error | undefined,
      client: realPg.PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): Promise<realPg.PoolClient> | undefined {
    if (callback !== undefined) {
      super.connect(callback);
      return undefined;
    }
    if (!arm.on) return super.connect();
    connects += 1;
    return connect() as Promise<realPg.PoolClient>;
  }
}

mock.module("pg", () => ({
  ...realPg,
  default: { ...realPg, Pool: PoolTrap },
  Pool: PoolTrap,
}));

// Arms the stub above for this file; unarmed, the real `pg` answers.
armWhileFileRuns(arm, () => {
  released.length = 0;
  asked.length = 0;
  connects = 0;
  connect = async () => stubClient();
  respond = answer;
});

/*
 * Dynamic on purpose: a static import is hoisted above the `mock.module` call,
 * so the driver would have closed over the real pool.
 */
const { createPostgresDb } = await import("../src/db/postgres.ts");

const DSN = "postgres://stub@127.0.0.1:1/stub";

/**
 * Waits for the probe to reach an observable point, without advancing a clock.
 *
 * A fixed number of microtask turns would be a guess about how many `await`s
 * the driver happens to have between the call and the query - it passes until
 * someone adds one. Bounded so a probe that never gets there fails here rather
 * than hanging the file.
 */
const reaches = async (ready: () => boolean) => {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (ready()) return;
    await Promise.resolve();
  }
  throw new Error("the probe never reached the expected point");
};

describe("the Postgres health probe", () => {
  test("returns its connection to the pool on the answering path", async () => {
    await createPostgresDb(DSN).probe(new AbortController().signal);

    expect(asked).toEqual(["select 1"]);
    expect(released).toEqual([{ destroyed: false }]);
  });

  test("takes a signal being optional at its word", async () => {
    // `Db.probe` declares it optional and nothing forces a caller to pass one.
    // Dereferencing it unguarded throws here, after a client is already
    // checked out - which is the leak this path exists to prevent.
    await createPostgresDb(DSN).probe();

    expect(asked).toEqual(["select 1"]);
    expect(released).toEqual([{ destroyed: false }]);
  });

  test("discards a connection whose query failed", async () => {
    // `pool.query` used to do this for us. A query that errors can leave the
    // protocol mid-message, so the client is not fit to hand to the next
    // caller - and every reader of a 503 here would be reading a lie.
    respond = async () => {
      throw new Error("terminating connection due to administrator command");
    };

    await expect(createPostgresDb(DSN).probe()).rejects.toThrow(
      "administrator command",
    );

    expect(released).toEqual([{ destroyed: true }]);
  });

  test("discards the connection when the caller gives up mid-query", async () => {
    // The response never arrives - a black-holed connection, or a server too
    // unwell to enforce its own `statement_timeout`. A running statement on a
    // healthy server is bounded already; this is the case that is not.
    respond = () => new Promise(() => {});
    const controller = new AbortController();
    const probing = createPostgresDb(DSN).probe(controller.signal);
    // The query is in flight, which is the state the abort has to interrupt.
    await reaches(() => asked.length === 1);

    controller.abort();

    // At the abort, not whenever `query_timeout` eventually fires and hands a
    // still-live connection back to the pool.
    expect(released).toEqual([{ destroyed: true }]);
    // That it rejects, not with what: a destroyed connection takes its query
    // down with whatever error the driver raises, and pinning this stub's
    // wording would assert the stub rather than the probe.
    await expect(probing).rejects.toThrow();
    // And once: the `finally` still runs, and releasing the same client twice
    // is an error `pg` throws.
    expect(released).toEqual([{ destroyed: true }]);
  });

  test("asks nothing of a client that arrives after the caller left", async () => {
    // Waiting for a free slot is bounded by `connectionTimeoutMillis`, which
    // outlasts the probe deadline, so this ordering is reachable whenever the
    // pool is saturated.
    let arrive: (client: unknown) => void = () => {};
    connect = () =>
      new Promise((resolve) => {
        arrive = resolve;
      });
    const controller = new AbortController();
    const probing = createPostgresDb(DSN).probe(controller.signal);
    // Waiting on the client, which is the state this test is about.
    await reaches(() => connects === 1);

    const reason = new Error("probe timed out after 2000ms");
    controller.abort(reason);
    arrive(stubClient());
    // Not a resolve: a probe that answers is one that reached the database.
    // The caller's own reason, so a handler can tell why it never did.
    await expect(probing).rejects.toBe(reason);

    expect(asked).toEqual([]);
    expect(released).toEqual([{ destroyed: true }]);
  });

  test("does not take a connection at all when already abandoned", async () => {
    const reason = new Error("gave up before asking");
    await expect(
      createPostgresDb(DSN).probe(AbortSignal.abort(reason)),
    ).rejects.toBe(reason);

    expect(connects).toBe(0);
    expect(released).toEqual([]);
  });
});
