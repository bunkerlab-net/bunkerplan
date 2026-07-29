-- SQLite has no `ADD CONSTRAINT`, so a unique index is the constraint and the
-- rename has to be a create and a drop. In that order: appliers that run these
-- statements one at a time rather than in a transaction would otherwise leave a
-- window with nothing enforcing uniqueness, and a create that fails would have
-- already dropped the index it was replacing.
--
-- No de-duplicating step is needed: the index being replaced has been unique
-- since 0005, so there can be no duplicate for the new one to reject.
CREATE UNIQUE INDEX `passkey_credential_id_unique` ON `passkey` (`credential_id`);--> statement-breakpoint
DROP INDEX `passkey_credentialID_idx`;
