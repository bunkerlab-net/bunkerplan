-- One statement rather than ADD CONSTRAINT ... NOT VALID followed by VALIDATE
-- CONSTRAINT. Splitting it is the right move when the two halves land in
-- separate transactions, because VALIDATE takes only SHARE UPDATE EXCLUSIVE
-- and lets writers through during the scan. Here they cannot: the migrator
-- wraps the whole batch in one transaction, so the ACCESS EXCLUSIVE lock the
-- ADD takes is held until commit either way and the split buys nothing but a
-- second statement. Every row already holds 'public' or 'private' - 0007 put
-- it there - so the scan finds no violation.
ALTER TABLE "plan" ADD CONSTRAINT "plan_visibility_check" CHECK ("visibility" in ('public', 'private'));
