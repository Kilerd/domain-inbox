import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { gzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import {
  parseDmarcXml,
  parseTlsRptJson,
  processReportAttachments,
} from "./reports";

const DMARC_XML = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc@google.com</email>
    <report_id>r1</report_id>
    <date_range><begin>1700000000</begin><end>1700086400</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.test</domain><p>reject</p><sp>none</sp><pct>100</pct>
  </policy_published>
  <record>
    <row><source_ip>1.2.3.4</source_ip><count>5</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.test</header_from></identifiers>
  </record>
  <record>
    <row><source_ip>5.6.7.8</source_ip><count>2</count>
      <policy_evaluated><disposition>reject</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>spoofed.test</header_from></identifiers>
  </record>
</feedback>`;

const TLS_JSON = JSON.stringify({
  "organization-name": "google.com",
  "report-id": "t1",
  "date-range": {
    "start-datetime": "2026-01-01T00:00:00Z",
    "end-datetime": "2026-01-02T00:00:00Z",
  },
  policies: [{ policy: { domain: "example.test", "policy-type": "sts" } }],
  summary: {
    "total-successful-session-count": 10,
    "total-failure-session-count": 2,
  },
  "failure-details": [{ "result-type": "certificate-expired" }],
});

let db: DatabaseSyncType;
let env: Env;

beforeEach(() => {
  db = openDb();
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,created_at)
      VALUES ('u_1','u@example.test','U','magic_link','owner',0);
    INSERT INTO domains (id,owner_id,domain,verification_status,created_at)
      VALUES ('d_1','u_1','example.test','verified',0);
  `);
  env = { DB: d1(db) } as unknown as Env;
});

afterEach(() => db.close());

describe("parseDmarcXml", () => {
  it("extracts metadata, policy and records", () => {
    const data = parseDmarcXml(DMARC_XML);
    expect(data).not.toBeNull();
    expect(data).toMatchObject({
      policyDomain: "example.test",
      orgName: "google.com",
      reportId: "r1",
      dateBegin: 1_700_000_000_000,
      dateEnd: 1_700_086_400_000,
    });
    expect(data!.records).toEqual([
      {
        sourceIp: "1.2.3.4",
        count: 5,
        disposition: "none",
        dkim: "pass",
        spf: "fail",
        headerFrom: "example.test",
        envelopeFrom: null,
      },
      {
        sourceIp: "5.6.7.8",
        count: 2,
        disposition: "reject",
        dkim: "fail",
        spf: "fail",
        headerFrom: "spoofed.test",
        envelopeFrom: null,
      },
    ]);
  });

  it("rejects non-DMARC XML", () => {
    expect(parseDmarcXml("<root><x>1</x></root>")).toBeNull();
  });
});

describe("parseTlsRptJson", () => {
  it("extracts policy, dates and summary", () => {
    const data = parseTlsRptJson(TLS_JSON);
    expect(data).toMatchObject({
      policyDomain: "example.test",
      orgName: "google.com",
      reportId: "t1",
      dateBegin: Date.parse("2026-01-01T00:00:00Z"),
      dateEnd: Date.parse("2026-01-02T00:00:00Z"),
    });
    expect(data!.summary).toMatchObject({
      "total-successful-session-count": 10,
    });
  });

  it("rejects unrelated JSON", () => {
    expect(parseTlsRptJson('{"hello":"world"}')).toBeNull();
  });
});

describe("processReportAttachments", () => {
  it("stores gzipped DMARC once and maps the policy domain", async () => {
    const gz = gzipSync(new TextEncoder().encode(DMARC_XML));
    const first = await processReportAttachments(env, "u_1", [
      { filename: "google.com!example.test!r1.xml.gz", mimeType: "application/gzip", content: gz },
    ]);
    expect(first).toEqual({ dmarc: 1, tls: 0 });

    const report = db
      .prepare(`SELECT id, domain_id, policy_domain, org_name, report_id FROM dmarc_reports`)
      .get() as Record<string, unknown>;
    expect(report).toMatchObject({
      domain_id: "d_1",
      policy_domain: "example.test",
      org_name: "google.com",
      report_id: "r1",
    });
    const records = db
      .prepare(`SELECT COUNT(*) AS n, SUM(count) AS c FROM dmarc_records`)
      .get() as { n: number; c: number };
    expect(records).toEqual({ n: 2, c: 7 });

    const second = await processReportAttachments(env, "u_1", [
      { filename: "google.com!example.test!r1.xml.gz", mimeType: "application/gzip", content: gz },
    ]);
    expect(second).toEqual({ dmarc: 0, tls: 0 });
  });

  it("stores a TLS-RPT JSON attachment", async () => {
    const result = await processReportAttachments(env, "u_1", [
      {
        filename: "google.com!example.test!t1.json",
        mimeType: "application/tlsrpt+json",
        content: new TextEncoder().encode(TLS_JSON),
      },
    ]);
    expect(result).toEqual({ dmarc: 0, tls: 1 });
    const row = db
      .prepare(`SELECT domain_id, policy_domain, org_name, report_id FROM tls_rpt_reports`)
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      domain_id: "d_1",
      policy_domain: "example.test",
      org_name: "google.com",
      report_id: "t1",
    });
  });
});
