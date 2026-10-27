-- Parsed DMARC aggregate reports and TLS-RPT reports. Raw report attachments
-- remain in the message; these tables hold the aggregates the dashboard reads.

CREATE TABLE dmarc_reports (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  domain_id     TEXT REFERENCES domains(id),
  policy_domain TEXT NOT NULL,
  org_name      TEXT NOT NULL,
  report_id     TEXT NOT NULL,
  date_begin    INTEGER,
  date_end      INTEGER,
  policy_json   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dmarc_unique
  ON dmarc_reports(owner_id, org_name, report_id);
CREATE INDEX idx_dmarc_owner_date
  ON dmarc_reports(owner_id, date_end DESC);

CREATE TABLE dmarc_records (
  id            TEXT PRIMARY KEY,
  report_id     TEXT NOT NULL REFERENCES dmarc_reports(id) ON DELETE CASCADE,
  source_ip     TEXT,
  count         INTEGER NOT NULL DEFAULT 0,
  disposition   TEXT,
  dkim          TEXT,
  spf           TEXT,
  header_from   TEXT,
  envelope_from TEXT
);
CREATE INDEX idx_dmarc_records_report ON dmarc_records(report_id);

CREATE TABLE tls_rpt_reports (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id),
  domain_id     TEXT REFERENCES domains(id),
  policy_domain TEXT,
  org_name      TEXT NOT NULL,
  report_id     TEXT NOT NULL,
  date_begin    INTEGER,
  date_end      INTEGER,
  summary_json  TEXT,
  failure_json  TEXT,
  policies_json TEXT,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_tlsrpt_unique
  ON tls_rpt_reports(owner_id, org_name, report_id);
CREATE INDEX idx_tlsrpt_owner_date
  ON tls_rpt_reports(owner_id, date_end DESC);
