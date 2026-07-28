CREATE TABLE "plan_grant" (
	"plan_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plan_grant_plan_id_user_id_pk" PRIMARY KEY("plan_id","user_id")
);
--> statement-breakpoint
-- Added as 'public' and then re-defaulted, rather than added as 'private' and
-- backfilled with an UPDATE. Existing plans were world-readable before this
-- migration and have to stay that way, and both of these statements are
-- catalog-only on PG 11+: no row is read or rewritten, whatever the size of
-- the table. An UPDATE would have touched every row to reach the same state.
ALTER TABLE "plan" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "share_code_hash" text;--> statement-breakpoint
ALTER TABLE "plan_grant" ADD CONSTRAINT "plan_grant_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_grant" ADD CONSTRAINT "plan_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_grant_userId_idx" ON "plan_grant" USING btree ("user_id");--> statement-breakpoint
-- New plans are private; only the rows that predate the column are public.
ALTER TABLE "plan" ALTER COLUMN "visibility" SET DEFAULT 'private';
