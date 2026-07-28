-- A public plan must not keep a share code. Before this, flipping a plan to
-- public left its digest in place: the code granted nothing while public, then
-- started working again the moment the plan went private, along with every
-- unlock cookie minted under it. Rows written under that behaviour are repaired
-- here, so "public implies no share code" holds for old rows as well as new.
UPDATE plan SET share_code_hash = NULL WHERE visibility = 'public';
