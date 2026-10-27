-- Per-owner outbound counter, keyed by UTC day. The UPSERT in
-- api/quotas.ts is atomic, so concurrent requests cannot exceed the cap.
CREATE TABLE send_usage (
  owner_id TEXT NOT NULL REFERENCES users(id),
  day      TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day)
);
