-- 0005_lifecycle.sql
-- Email lifecycle: bounce/complaint ingest, suppressions, templates, tracking.
--
-- Bounce path = DSN reverse lookup (VERP not feasible: CF Email Sending refuses
-- envelope MAIL FROM = subdomain of an owned zone; we tested cf-bounce.<domain>
-- and got "email sending not authorized for subdomain"). So bounce DSN emails
-- arrive at the apex catch-all (e.g. hello@<your-domain>), and we correlate
-- back to the originating outbound via the rfc822_message_id embedded in the
-- DSN body.

-- ── suppressions (auto + manual) ──────────────────────────────────────────
CREATE TABLE suppressions (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES users(id),
  email               TEXT NOT NULL,
  reason              TEXT NOT NULL,  -- hard_bounce | complaint | manual
  source_outbound_id  TEXT,           -- the send that triggered auto-suppression, NULL for manual
  created_at          INTEGER NOT NULL,
  UNIQUE(owner_id, email)
);
CREATE INDEX idx_suppressions_owner_created ON suppressions(owner_id, created_at DESC);

-- ── templates ─────────────────────────────────────────────────────────────
CREATE TABLE templates (
  id                TEXT PRIMARY KEY,           -- tpl_<uuid>
  owner_id          TEXT NOT NULL REFERENCES users(id),
  name              TEXT NOT NULL,
  subject           TEXT,
  html              TEXT,
  text              TEXT,
  variables_schema  TEXT,                       -- JSON schema for {{vars}}, optional
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(owner_id, name)
);
CREATE INDEX idx_templates_owner ON templates(owner_id, updated_at DESC);

-- ── outbound_messages: bounce/complaint state + tracking counts + template link
ALTER TABLE outbound_messages ADD COLUMN bounced_at         INTEGER;
ALTER TABLE outbound_messages ADD COLUMN bounce_type        TEXT;     -- hard | soft | complaint | undeliverable
ALTER TABLE outbound_messages ADD COLUMN bounce_diag        TEXT;     -- SMTP diagnostic-code from DSN
ALTER TABLE outbound_messages ADD COLUMN tracking_enabled   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_messages ADD COLUMN open_count         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_messages ADD COLUMN click_count        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_messages ADD COLUMN template_id        TEXT REFERENCES templates(id);

-- Helpful index for status-filtered listing on the new GET /api/v1/emails endpoint.
CREATE INDEX idx_outbound_owner_status_created ON outbound_messages(owner_id, status, created_at DESC);

-- ── domains: per-domain tracking defaults ──────────────────────────────────
-- Tracking is on by default per user decision; per-send `tracking:{opens,clicks}`
-- still overrides.
ALTER TABLE domains ADD COLUMN open_tracking  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE domains ADD COLUMN click_tracking INTEGER NOT NULL DEFAULT 1;

-- ── events: extra dimensions for the lifecycle timeline UI ────────────────
-- email_id is a denormalized pointer = outbound_id for outbound events, or
-- messages.id for inbound. Lets us query a single timeline with one index.
ALTER TABLE events ADD COLUMN email_id TEXT;
CREATE INDEX idx_events_email_id_created ON events(email_id, created_at DESC);
CREATE INDEX idx_events_owner_type_created ON events(owner_id, type, created_at DESC);
