-- 0008: Idempotency-Key expires after 24 h, payload mismatch is a 409 (#2).
--
-- Additive only (no table rebuild): UNIQUE(owner_id, idempotency_key) stays
-- as the atomic reservation; the Worker releases (nulls) keys older than
-- 24 h before reuse and in the cron sweep.

-- SHA-256 (hex) of the canonical JSON request body that reserved the key, so
-- a replay with a different payload inside the window can be rejected with
-- 409 invalid_idempotent_request. NULL for rows created before this
-- migration; those are treated as matching any payload.
ALTER TABLE outbound_messages ADD COLUMN idempotency_hash TEXT;

-- Lets the cron sweep find still-keyed rows past the window without scanning
-- the whole table; only rows that currently hold a key are indexed.
CREATE INDEX IF NOT EXISTS idx_outbound_idem_created
  ON outbound_messages(created_at)
  WHERE idempotency_key IS NOT NULL;
