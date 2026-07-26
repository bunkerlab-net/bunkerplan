import { d1Db } from "./backends.ts";
import { describeAccountClosingRepo } from "./contract/account-closing-repo.ts";
import { describePlanRepo } from "./contract/plan-repo.ts";
import { describeRateLimitRepo } from "./contract/rate-limit-repo.ts";
import { describeSchema } from "./contract/schema.ts";

/**
 * D1 on real workerd, with the `drizzle/sqlite` migrations applied. One
 * backend per file so `bun test --parallel` gives each its own process - see
 * tests/drivers/plan-storage.r2.test.ts for why that matters.
 */
const skip = false;

describePlanRepo("D1", d1Db, { skip });
describeRateLimitRepo("D1", d1Db, { skip });
describeAccountClosingRepo("D1", d1Db, { skip });
describeSchema("D1", d1Db, { skip });
