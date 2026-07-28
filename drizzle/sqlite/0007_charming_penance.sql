-- Hand-ordered: `plan` is rebuilt first, and `plan_grant` is created after it.
--
-- SQLite cannot ADD CONSTRAINT, so the CHECK on `visibility` can only arrive
-- by rebuilding the table, and a rebuild drops the old one. Doing that while
-- `plan_grant` exists would fire its ON DELETE CASCADE and take every grant
-- with it: the migrator runs the batch in one transaction, and `PRAGMA
-- foreign_keys=OFF` is a no-op inside one. Creating the child table afterwards
-- means there is nothing to cascade to, so no guard is needed.
--
-- The rebuild also carries the backfill. Plans written before this migration
-- were world-readable and stay that way, which is the 'public' literal below;
-- the column default is 'private', so plans written afterwards are not.
CREATE TABLE `__new_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`size` integer NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`share_code_hash` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plan_visibility_check" CHECK("visibility" in ('public', 'private'))
);
--> statement-breakpoint
INSERT INTO `__new_plan`("id", "user_id", "label", "size", "visibility", "share_code_hash", "created_at") SELECT "id", "user_id", "label", "size", 'public', NULL, "created_at" FROM `plan`;--> statement-breakpoint
DROP TABLE `plan`;--> statement-breakpoint
ALTER TABLE `__new_plan` RENAME TO `plan`;--> statement-breakpoint
CREATE INDEX `plan_userId_idx` ON `plan` (`user_id`);--> statement-breakpoint
CREATE TABLE `plan_grant` (
	`plan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`plan_id`, `user_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plan_grant_userId_idx` ON `plan_grant` (`user_id`);
