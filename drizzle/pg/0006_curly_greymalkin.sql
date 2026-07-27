CREATE TABLE "account_closing" (
	"user_id" text PRIMARY KEY NOT NULL,
	"started_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_closing" ADD CONSTRAINT "account_closing_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
