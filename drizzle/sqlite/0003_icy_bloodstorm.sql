PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_upload_rate_limit` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL,
	FOREIGN KEY (`key`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_upload_rate_limit`("key", "count", "window_start") SELECT "key", "count", "window_start" FROM `upload_rate_limit`;--> statement-breakpoint
DROP TABLE `upload_rate_limit`;--> statement-breakpoint
ALTER TABLE `__new_upload_rate_limit` RENAME TO `upload_rate_limit`;--> statement-breakpoint
PRAGMA foreign_keys=ON;