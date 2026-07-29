-- `USING INDEX` promotes the index 0005 already made unique rather than
-- building a second one, which is also why no de-duplicating step is needed:
-- the index being promoted has been refusing duplicates since it was created,
-- so there can be none to clean up. Postgres renames it to the constraint.
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_credential_id_unique" UNIQUE USING INDEX "passkey_credentialID_idx";
