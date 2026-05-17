-- 0006_tracking_columns.sql
-- Add first/last opened+clicked timestamps to outbound_messages so the
-- activity panel can render a real timeline ("first opened 5m after send,
-- last opened 4d after send"). The simple counts in 0005 are still useful
-- for sortable list rendering, but they don't help you answer "did the
-- recipient open it the day they got it or a week later".

ALTER TABLE outbound_messages ADD COLUMN first_opened_at  INTEGER;
ALTER TABLE outbound_messages ADD COLUMN last_opened_at   INTEGER;
ALTER TABLE outbound_messages ADD COLUMN first_clicked_at INTEGER;
ALTER TABLE outbound_messages ADD COLUMN last_clicked_at  INTEGER;
