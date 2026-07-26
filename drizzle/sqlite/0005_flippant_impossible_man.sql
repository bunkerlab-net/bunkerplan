DROP INDEX `passkey_credentialID_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credentialID_idx` ON `passkey` (`credential_id`);