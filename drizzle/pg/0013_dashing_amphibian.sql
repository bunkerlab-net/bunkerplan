/*
	Hand-written. Drizzle emitted `ADD COLUMN "attempt_id" text PRIMARY KEY NOT
	NULL` beside a commented-out placeholder for dropping the old primary key,
	which fails twice over on a populated table: a NOT NULL column with no
	default cannot be added to existing rows, and a second PRIMARY KEY cannot be
	added while the first is still there.

	Nullable, backfill, then constrain - the order that works with rows already
	present. `legacy:` + user_id is deterministic and unique, because the old
	primary key was the user id: the backfill computes the same value however
	often it is reached, rather than minting a fresh one. Those rows keep
	blocking their accounts' writes, which is what they were already doing, and
	the next successful deletion of the account cascades them away.
*/

ALTER TABLE "account_closing" ADD COLUMN "attempt_id" text;--> statement-breakpoint
UPDATE "account_closing" SET "attempt_id" = 'legacy:' || "user_id" WHERE "attempt_id" IS NULL;--> statement-breakpoint
ALTER TABLE "account_closing" ALTER COLUMN "attempt_id" SET NOT NULL;--> statement-breakpoint
-- Dropping the primary key leaves its columns NOT NULL in Postgres, but the
-- schema now declares that for `user_id` in its own right, so it is stated
-- rather than inherited from a constraint that is going away.
ALTER TABLE "account_closing" DROP CONSTRAINT "account_closing_pkey";--> statement-breakpoint
ALTER TABLE "account_closing" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "account_closing" ADD CONSTRAINT "account_closing_pkey" PRIMARY KEY ("attempt_id");--> statement-breakpoint
CREATE INDEX "account_closing_user_idx" ON "account_closing" USING btree ("user_id");
