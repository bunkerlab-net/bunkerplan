-- The key changed from a client address to a keyed digest of one, so rows
-- written before that hold raw addresses and can never be matched again. They
-- are ephemeral rate-limit counters: deleting them resets whatever allowances
-- were in flight at deploy time, which is an acceptable one-off during a change
-- of key format. Left alone they would be unreachable rows holding addresses,
-- and the sweep that collects closed windows runs on only a fraction of
-- redemptions, so a quiet deployment could keep them indefinitely.
DELETE FROM unlock_rate_limit;
