import { DATABASE_URL, postgresDb } from "./backends.ts";
import { describeAccountClosingRepo } from "./contract/account-closing-repo.ts";
import { describePlanRepo } from "./contract/plan-repo.ts";
import { describeRateLimitRepo } from "./contract/rate-limit-repo.ts";
import { describeSchema } from "./contract/schema.ts";

/**
 * `DB_DRIVER=postgres`, against a real server in a scratch schema.
 *
 * This is the dialect the SQLite suites cannot stand in for. Postgres reads
 * the plan count from its own snapshot under READ COMMITTED, so the ceiling is
 * held by an advisory lock rather than by SQLite serialising writers - and
 * that lock only exists against a server.
 */
const skip = DATABASE_URL === undefined;

describePlanRepo("Postgres", postgresDb, { skip });
describeRateLimitRepo("Postgres", postgresDb, { skip });
describeAccountClosingRepo("Postgres", postgresDb, { skip });
describeSchema("Postgres", postgresDb, { skip });
