CREATE TABLE `plan_grant` (
	`plan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`plan_id`, `user_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `plan`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plan_grant_userId_idx` ON `plan_grant` (`user_id`);--> statement-breakpoint
ALTER TABLE `plan` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE `plan` ADD `share_code_hash` text;--> statement-breakpoint
UPDATE `plan` SET `visibility` = 'public';