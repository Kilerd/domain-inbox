-- 0007_dedup_scope_webhook_retry.sql
--
-- 1. messages.rfc822_message_id: global UNIQUE → per-owner UNIQUE.
--    The same RFC822 message legitimately lands once per recipient tenant
--    (one delivery To: a@owner1.com, b@owner2.com fans out to two owners);
--    the old global constraint silently dropped the second owner's copy.
--    SQLite can't drop an inline UNIQUE, so rebuild the table.
-- 2. attachments: enforce the composite unique the parser's INSERT OR IGNORE
--    assumes (dedupe any strays first).
-- 3. webhook_deliveries: columns needed for real retries (payload snapshot,
--    stable svix msg id, last error).
-- 4. threads: index backing the subject-fallback lookup in assignThread.
--
-- Rebuild recipe: D1 can't disable foreign_keys, only defer them — and a
-- deferred DROP TABLE of a referenced parent counts one violation per child
-- row, which renaming the replacement table does NOT cancel. So children are
-- stashed and detached first, the parent rebuilt, then references restored
-- (dropping any that pointed at rows which no longer exist).

PRAGMA defer_foreign_keys = on;

-- Detach every reference into messages.
CREATE TABLE _mig7_attachments AS SELECT * FROM attachments;
DELETE FROM attachments;

CREATE TABLE _mig7_events_msg AS
  SELECT id, message_id FROM events WHERE message_id IS NOT NULL;
UPDATE events SET message_id = NULL WHERE message_id IS NOT NULL;

CREATE TABLE _mig7_om_rendered AS
  SELECT id, rendered_message_id FROM outbound_messages
  WHERE rendered_message_id IS NOT NULL;
UPDATE outbound_messages SET rendered_message_id = NULL
 WHERE rendered_message_id IS NOT NULL;

-- Null out any dangling outbound references in messages themselves
-- (existing installs can hold rows pointing at since-deleted parents).
UPDATE messages SET thread_id = NULL
 WHERE thread_id IS NOT NULL AND thread_id NOT IN (SELECT id FROM threads);
UPDATE messages SET alias_id = NULL
 WHERE alias_id IS NOT NULL AND alias_id NOT IN (SELECT id FROM aliases);
UPDATE messages SET domain_id = NULL
 WHERE domain_id IS NOT NULL AND domain_id NOT IN (SELECT id FROM domains);
UPDATE events SET outbound_id = NULL
 WHERE outbound_id IS NOT NULL
   AND outbound_id NOT IN (SELECT id FROM outbound_messages);

-- Rebuild messages without the inline global UNIQUE.
CREATE TABLE messages_new (
  id                   TEXT PRIMARY KEY,
  thread_id            TEXT REFERENCES threads(id),
  owner_id             TEXT NOT NULL,
  domain_id            TEXT REFERENCES domains(id),
  alias_id             TEXT REFERENCES aliases(id),
  rfc822_message_id    TEXT,                                  -- inbound dedup key (per owner)
  in_reply_to          TEXT,
  references_json      TEXT,
  direction            TEXT NOT NULL,                         -- inbound|outbound
  from_addr            TEXT,
  from_name            TEXT,
  to_json              TEXT,
  cc_json              TEXT,
  bcc_json             TEXT,
  reply_to             TEXT,
  subject              TEXT,
  snippet              TEXT,
  received_at          INTEGER,
  sent_at              INTEGER,
  r2_key               TEXT,                                  -- raw MIME location
  size_bytes           INTEGER,
  has_attachments      INTEGER NOT NULL DEFAULT 0,
  attachment_count     INTEGER NOT NULL DEFAULT 0,
  flags_bitmap         INTEGER NOT NULL DEFAULT 0,            -- read|starred|...
  spam_score           REAL,
  dkim_pass            INTEGER,
  spf_pass             INTEGER,
  dmarc_pass           INTEGER,
  parse_status         TEXT NOT NULL DEFAULT 'raw_only',      -- raw_only|parsed|failed|duplicate
  parse_error          TEXT,
  created_at           INTEGER NOT NULL
);

INSERT INTO messages_new
  SELECT id, thread_id, owner_id, domain_id, alias_id, rfc822_message_id,
         in_reply_to, references_json, direction, from_addr, from_name,
         to_json, cc_json, bcc_json, reply_to, subject, snippet,
         received_at, sent_at, r2_key, size_bytes, has_attachments,
         attachment_count, flags_bitmap, spam_score, dkim_pass, spf_pass,
         dmarc_pass, parse_status, parse_error, created_at
  FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX idx_messages_thread_received ON messages(thread_id, received_at);
CREATE INDEX idx_messages_owner_received ON messages(owner_id, received_at DESC);
CREATE INDEX idx_messages_alias_received ON messages(alias_id, received_at DESC);
CREATE INDEX idx_messages_direction ON messages(owner_id, direction, created_at DESC);
CREATE UNIQUE INDEX idx_messages_owner_rfc822 ON messages(owner_id, rfc822_message_id);

-- Restore the stashed references, dropping any whose parent no longer exists.
INSERT INTO attachments
  SELECT * FROM _mig7_attachments
  WHERE message_id IN (SELECT id FROM messages);
DROP TABLE _mig7_attachments;

UPDATE events
   SET message_id = (SELECT message_id FROM _mig7_events_msg
                     WHERE _mig7_events_msg.id = events.id)
 WHERE id IN (SELECT id FROM _mig7_events_msg
              WHERE message_id IN (SELECT id FROM messages));
DROP TABLE _mig7_events_msg;

UPDATE outbound_messages
   SET rendered_message_id = (SELECT rendered_message_id FROM _mig7_om_rendered
                              WHERE _mig7_om_rendered.id = outbound_messages.id)
 WHERE id IN (SELECT id FROM _mig7_om_rendered
              WHERE rendered_message_id IN (SELECT id FROM messages));
DROP TABLE _mig7_om_rendered;

DELETE FROM attachments
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM attachments GROUP BY message_id, sha256
 );
CREATE UNIQUE INDEX idx_attachments_msg_sha ON attachments(message_id, sha256);

ALTER TABLE webhook_deliveries ADD COLUMN event_type   TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN payload_json TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN svix_msg_id  TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN last_error   TEXT;

CREATE INDEX idx_threads_owner_subject_lma
  ON threads(owner_id, subject_normalized, last_message_at DESC);
