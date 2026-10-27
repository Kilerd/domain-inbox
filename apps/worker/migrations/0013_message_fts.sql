-- Full-text index over parsed messages. Body text is a truncated plain-text
-- copy (max 64 KiB per message); the raw MIME stays in R2.
CREATE VIRTUAL TABLE message_fts USING fts5(
  message_id UNINDEXED,
  owner_id   UNINDEXED,
  thread_id  UNINDEXED,
  subject,
  body,
  from_addr,
  to_text,
  tokenize = 'unicode61'
);
