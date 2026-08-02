PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account_closing` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Existing markers carry over as attempts of their own. Drizzle generated
-- `SELECT "attempt_id"` here, a column the old table does not have, so the
-- migration would fail on any database that has run before this one.
-- `legacy:` + user_id is deterministic, and unique because the old primary
-- key was the user id. Such a row keeps blocking that account's writes -
-- which is what it was already doing - and the next successful deletion of
-- the account cascades it away.
INSERT INTO `__new_account_closing`("attempt_id", "user_id", "started_at") SELECT 'legacy:' || "user_id", "user_id", "started_at" FROM `account_closing`;--> statement-breakpoint
DROP TABLE `account_closing`;--> statement-breakpoint
ALTER TABLE `__new_account_closing` RENAME TO `account_closing`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `account_closing_user_idx` ON `account_closing` (`user_id`);
