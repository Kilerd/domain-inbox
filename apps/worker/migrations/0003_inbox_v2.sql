-- 0003_inbox_v2.sql
--
-- Inbox UX foundations: per-alias counters so the Navigator can render
-- unread badges without scanning messages, plus indexes for filtered thread
-- queries. Also formalizes the `flags_bitmap` bit conventions used by both
-- `messages` and `threads`:
--
--   bit 0  read     — messages only (threads derive from unread_count)
--   bit 1  starred  — threads (UI level) + messages (optional)
--   bit 2  archived — threads
--   bit 3  trash    — threads
--   bit 4  spam     — threads
--   bit 5  muted    — threads (future: mute = don't surface in Inbox view)

-- ── aliases counters ────────────────────────────────────────────────────────
ALTER TABLE aliases ADD COLUMN message_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aliases ADD COLUMN unread_count    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aliases ADD COLUMN last_message_at INTEGER;
-- `hidden=1` keeps an alias out of Navigator by default (user-pinned noise reduction).
ALTER TABLE aliases ADD COLUMN hidden          INTEGER NOT NULL DEFAULT 0;

-- ── threads / aliases new indexes for the filtered view queries ─────────────
CREATE INDEX idx_threads_owner_flags_lma
  ON threads(owner_id, flags_bitmap, last_message_at DESC);

CREATE INDEX idx_aliases_domain_lma
  ON aliases(domain_id, last_message_at DESC);

-- Existing index on (owner_id, domain_id, last_message_at DESC) covers the
-- by-domain navigator query path.

-- ── backfill counters for any pre-existing rows ─────────────────────────────
-- We don't have explicit messages.alias_id values populated by old ingests,
-- so reconstruct alias_id from messages.to_json[0] when missing, then update
-- counters. Safe to run; aliases are unique by (domain_id, local_part).
UPDATE messages
  SET alias_id = (
    SELECT a.id FROM aliases a
    WHERE a.full_address = lower(substr(json_extract(messages.to_json, '$[0]'), 1, instr(json_extract(messages.to_json, '$[0]'), '@')-1) || '@' || substr(json_extract(messages.to_json, '$[0]'), instr(json_extract(messages.to_json, '$[0]'), '@')+1))
    LIMIT 1
  )
  WHERE alias_id IS NULL
    AND direction = 'inbound'
    AND to_json IS NOT NULL;

UPDATE aliases
  SET message_count = (
    SELECT COUNT(*) FROM messages m
    WHERE m.alias_id = aliases.id
      AND m.parse_status != 'duplicate'
      AND m.direction = 'inbound'
  ),
  unread_count = (
    SELECT COUNT(*) FROM messages m
    WHERE m.alias_id = aliases.id
      AND m.parse_status != 'duplicate'
      AND m.direction = 'inbound'
      AND (m.flags_bitmap & 1) = 0
  ),
  last_message_at = (
    SELECT MAX(received_at) FROM messages m
    WHERE m.alias_id = aliases.id
      AND m.parse_status != 'duplicate'
      AND m.direction = 'inbound'
  );
