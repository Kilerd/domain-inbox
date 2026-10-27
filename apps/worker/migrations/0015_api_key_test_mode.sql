-- Test-mode API keys (re_test_…) record sends/events without delivery and
-- without touching the inbox. Mark outbound rows so Activity/API can tell.
ALTER TABLE api_keys ADD COLUMN test_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_messages ADD COLUMN test_mode INTEGER NOT NULL DEFAULT 0;
