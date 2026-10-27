-- Columns added for surfaces that were never shipped, plus two indexes no
-- query uses. Nothing in src/ references any of them any more.
DROP INDEX IF EXISTS idx_aliases_full;
DROP INDEX IF EXISTS idx_aliases_target;
DROP INDEX IF EXISTS idx_events_message;

-- events.email_id is the live pointer (outbound id or message id); the legacy
-- message_id column was never written after 0005.
ALTER TABLE events DROP COLUMN message_id;

-- Inbound auth results are not persisted (the MTA already validated them).
ALTER TABLE messages DROP COLUMN spam_score;
ALTER TABLE messages DROP COLUMN dkim_pass;
ALTER TABLE messages DROP COLUMN spf_pass;
ALTER TABLE messages DROP COLUMN dmarc_pass;

-- The Cloudflare binding returns no provider id, and there is one channel.
ALTER TABLE outbound_messages DROP COLUMN provider_message_id;
ALTER TABLE outbound_messages DROP COLUMN channel;

-- DKIM/SPF/DMARC state is discovered live from DNS (api/dns.ts), not stored.
ALTER TABLE domains DROP COLUMN dkim_selector;
ALTER TABLE domains DROP COLUMN dkim_public_key;
ALTER TABLE domains DROP COLUMN dkim_private_key_kv_key;
ALTER TABLE domains DROP COLUMN spf_state;
ALTER TABLE domains DROP COLUMN dmarc_state;
