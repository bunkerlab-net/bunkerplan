DROP INDEX "passkey_credentialID_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");
