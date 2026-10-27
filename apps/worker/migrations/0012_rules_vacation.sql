-- Inbound automation: user rules, a per-owner vacation responder, and the
-- per-sender dedupe log for auto-replies.

CREATE TABLE email_rules (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 100,
  match_json  TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_rules_owner_priority
  ON email_rules(owner_id, enabled, priority, created_at);

CREATE TABLE vacation_responders (
  owner_id   TEXT PRIMARY KEY REFERENCES users(id),
  enabled    INTEGER NOT NULL DEFAULT 0,
  subject    TEXT,
  body_text  TEXT NOT NULL DEFAULT '',
  start_at   INTEGER,
  end_at     INTEGER,
  updated_at INTEGER NOT NULL
);

-- One row per sender; sent_at is refreshed on each auto-reply so we can
-- suppress repeats for a few days without growing a history.
CREATE TABLE auto_reply_log (
  owner_id  TEXT NOT NULL REFERENCES users(id),
  recipient TEXT NOT NULL,
  sent_at   INTEGER NOT NULL,
  PRIMARY KEY (owner_id, recipient)
);
CREATE INDEX idx_auto_reply_sent ON auto_reply_log(owner_id, sent_at);
