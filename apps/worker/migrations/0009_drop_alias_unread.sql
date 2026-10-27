-- aliases.unread_count is derived from messages at read time now
-- (inbound, parsed, not auxiliary, not read). Keeping a second writer was
-- the source of drift; dropping the column removes the stale copy.
ALTER TABLE aliases DROP COLUMN unread_count;
