import { bunSqliteDb } from "./backends.ts";
import { describeAccountClosingRepo } from "./contract/account-closing-repo.ts";
import { describePlanRepo } from "./contract/plan-repo.ts";
import { describeRateLimitRepo } from "./contract/rate-limit-repo.ts";
import { describeSchema } from "./contract/schema.ts";
import { describeUnlockRateLimitRepo } from "./contract/unlock-rate-limit-repo.ts";

/**
 * `DB_DRIVER=sqlite`, the same repositories D1 uses but reached through
 * `bun:sqlite` rather than a binding. Running both proves the SQL is portable
 * across the two, which is the claim src/db/plans.sqlite.ts makes.
 */
const skip = false;

describePlanRepo("bun:sqlite", bunSqliteDb, { skip });
describeRateLimitRepo("bun:sqlite", bunSqliteDb, { skip });
describeUnlockRateLimitRepo("bun:sqlite", bunSqliteDb, { skip });
describeAccountClosingRepo("bun:sqlite", bunSqliteDb, { skip });
describeSchema("bun:sqlite", bunSqliteDb, { skip });
