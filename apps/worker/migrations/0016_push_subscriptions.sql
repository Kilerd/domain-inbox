-- Web Push subscriptions (one row per browser/device endpoint).
CREATE TABLE push_subscriptions (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  endpoint     TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(owner_id, endpoint)
);
CREATE INDEX idx_push_owner ON push_subscriptions(owner_id);
