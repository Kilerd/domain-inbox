-- 0001_init.sql
-- Initial schema for domain-inbox.
-- D1 quirks: no transactions, 1MB row limit, SQLite syntax.
-- All writes are designed to be idempotent (upsert on natural keys).

-- ── users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id           TEXT PRIMARY KEY,           -- ULID
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'cf_access',
  created_at   INTEGER NOT NULL,           -- unix ms
  last_seen_at INTEGER
);

-- ── domains ─────────────────────────────────────────────────────────────────
CREATE TABLE domains (
  id                       TEXT PRIMARY KEY,
  owner_id                 TEXT NOT NULL REFERENCES users(id),
  domain                   TEXT NOT NULL UNIQUE,
  verification_status      TEXT NOT NULL DEFAULT 'pending',   -- pending|verified|failed
  email_routing_rule_id    TEXT,
  dkim_selector            TEXT,
  dkim_public_key          TEXT,
  dkim_private_key_kv_key  TEXT,
  catch_all_enabled        INTEGER NOT NULL DEFAULT 1,
  spf_state                TEXT,
  dmarc_state              TEXT,
  created_at               INTEGER NOT NULL,
  verified_at              INTEGER
);
CREATE INDEX idx_domains_owner ON domains(owner_id);

-- ── aliases ─────────────────────────────────────────────────────────────────
-- Explicit named addresses OR auto-created entries observed in incoming mail.
CREATE TABLE aliases (
  id               TEXT PRIMARY KEY,
  domain_id        TEXT NOT NULL REFERENCES domains(id),
  local_part       TEXT NOT NULL,
  full_address     TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'explicit',         -- explicit|auto_created
  target_user_id   TEXT REFERENCES users(id),
  label            TEXT,
  disabled         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  UNIQUE(domain_id, local_part)
);
CREATE INDEX idx_aliases_target ON aliases(target_user_id, full_address);
CREATE INDEX idx_aliases_full ON aliases(full_address);

-- ── threads ─────────────────────────────────────────────────────────────────
CREATE TABLE threads (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES users(id),
  domain_id           TEXT REFERENCES domains(id),
  subject_normalized  TEXT,
  participants_json   TEXT,
  last_message_at     INTEGER NOT NULL,
  first_message_at    INTEGER NOT NULL,
  message_count       INTEGER NOT NULL DEFAULT 0,
  unread_count        INTEGER NOT NULL DEFAULT 0,
  flags_bitmap        INTEGER NOT NULL DEFAULT 0              -- starred|archived|spam|trash
);
CREATE INDEX idx_threads_owner_lma ON threads(owner_id, last_message_at DESC);
CREATE INDEX idx_threads_owner_domain_lma ON threads(owner_id, domain_id, last_message_at DESC);

-- ── messages ────────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id                   TEXT PRIMARY KEY,
  thread_id            TEXT REFERENCES threads(id),
  owner_id             TEXT NOT NULL,
  domain_id            TEXT REFERENCES domains(id),
  alias_id             TEXT REFERENCES aliases(id),
  rfc822_message_id    TEXT UNIQUE,                           -- inbound dedup key
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
  parse_status         TEXT NOT NULL DEFAULT 'raw_only',      -- raw_only|parsed|failed
  parse_error          TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX idx_messages_thread_received ON messages(thread_id, received_at);
CREATE INDEX idx_messages_owner_received ON messages(owner_id, received_at DESC);
CREATE INDEX idx_messages_alias_received ON messages(alias_id, received_at DESC);
CREATE INDEX idx_messages_direction ON messages(owner_id, direction, created_at DESC);

-- ── attachments ─────────────────────────────────────────────────────────────
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id),
  filename     TEXT,
  content_type TEXT,
  size_bytes   INTEGER,
  content_id   TEXT,
  is_inline    INTEGER NOT NULL DEFAULT 0,
  r2_key       TEXT NOT NULL,
  sha256       TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_sha ON attachments(sha256);

-- ── api_keys ────────────────────────────────────────────────────────────────
CREATE TABLE api_keys (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL REFERENCES users(id),
  name               TEXT,
  prefix             TEXT NOT NULL UNIQUE,        -- e.g. "re_live_AbCd1234"
  key_hash           TEXT NOT NULL,               -- sha256 of full token
  scopes_json        TEXT NOT NULL,               -- ["emails.send", ...]
  domain_scope_json  TEXT,                        -- null = all owner domains
  last_used_at       INTEGER,
  created_at         INTEGER NOT NULL,
  revoked_at         INTEGER
);
CREATE INDEX idx_apikeys_owner ON api_keys(owner_id);

-- ── outbound_messages ───────────────────────────────────────────────────────
CREATE TABLE outbound_messages (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES users(id),
  api_key_id          TEXT REFERENCES api_keys(id),
  idempotency_key     TEXT,
  status              TEXT NOT NULL DEFAULT 'queued',  -- queued|sending|sent|delivered|bounced|complained|failed|canceled
  channel             TEXT NOT NULL DEFAULT 'cf_native',
  provider_message_id TEXT,
  request_json        TEXT NOT NULL,
  rendered_message_id TEXT REFERENCES messages(id),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  scheduled_at        INTEGER,
  created_at          INTEGER NOT NULL,
  sent_at             INTEGER,
  UNIQUE(owner_id, idempotency_key)
);
CREATE INDEX idx_outbound_owner_created ON outbound_messages(owner_id, created_at DESC);
CREATE INDEX idx_outbound_status ON outbound_messages(status);

-- ── webhook_endpoints ───────────────────────────────────────────────────────
CREATE TABLE webhook_endpoints (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id),
  url               TEXT NOT NULL,
  secret            TEXT NOT NULL,                  -- whsec_...
  event_types_json  TEXT NOT NULL,                  -- ["email.delivered", ...]
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_webhook_owner ON webhook_endpoints(owner_id);

-- ── webhook_deliveries ──────────────────────────────────────────────────────
CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,
  endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id),
  event_id        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed|dead
  response_code   INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_retry_at   INTEGER,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
);
CREATE INDEX idx_wd_endpoint_created ON webhook_deliveries(endpoint_id, created_at DESC);
CREATE INDEX idx_wd_status_retry ON webhook_deliveries(status, next_retry_at);

-- ── events ──────────────────────────────────────────────────────────────────
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  type          TEXT NOT NULL,                     -- email.sent|delivered|bounced|opened|clicked|received|...
  message_id    TEXT REFERENCES messages(id),
  outbound_id   TEXT REFERENCES outbound_messages(id),
  payload_json  TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_events_owner_created ON events(owner_id, created_at DESC);
CREATE INDEX idx_events_message ON events(message_id);
CREATE INDEX idx_events_outbound ON events(outbound_id);
