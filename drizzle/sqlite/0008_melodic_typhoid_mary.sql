PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
INSERT INTO `__new_plan`("id", "user_id", "label", "size", "visibility", "share_code_hash", "created_at") SELECT "id", "user_id", "label", "size", "visibility", "share_code_hash", "created_at" FROM `plan`;--> statement-breakpoint
DROP TABLE `plan`;--> statement-breakpoint
ALTER TABLE `__new_plan` RENAME TO `plan`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `plan_userId_idx` ON `plan` (`user_id`);