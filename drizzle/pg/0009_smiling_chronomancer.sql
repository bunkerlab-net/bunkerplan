CREATE TABLE "unlock_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "unlock_rate_limit_windowStart_idx" ON "unlock_rate_limit" USING btree ("window_start");
