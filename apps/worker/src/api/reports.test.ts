import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import { handleReports } from "./reports";

const USER: AuthUser = { id: "u_1", email: "u@example.test", name: "U", is_new: false };
const NOW = Date.now();

let db: DatabaseSyncType;
let env: Env;

function seed() {
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,created_at)
      VALUES ('u_1','u@example.test','U','magic_link','owner',0);
    INSERT INTO dmarc_reports
      (id,owner_id,policy_domain,org_name,report_id,date_begin,date_end,policy_json,created_at)
      VALUES
      ('dmr_1','u_1','example.test','google.com','r1',${NOW - 86_400_000},${NOW - 86_400_000},'{}',0),
      ('dmr_2','u_1','other.test','yahoo.com','r2',${NOW - 2 * 86_400_000},${NOW - 2 * 86_400_000},'{}',0);
    INSERT INTO dmarc_records
      (id,report_id,source_ip,count,disposition,dkim,spf,header_from)
      VALUES
      ('rec_1','dmr_1','1.1.1.1',5,'none','pass','fail','example.test'),
      ('rec_2','dmr_1','2.2.2.2',2,'quarantine','fail','fail','example.test'),
      ('rec_3','dmr_1','3.3.3.3',1,'reject','fail','fail','spoof.test'),
      ('rec_4','dmr_2','4.4.4.4',10,'none','pass','pass','other.test');
    INSERT INTO tls_rpt_reports
      (id,owner_id,policy_domain,org_name,report_id,date_begin,date_end,
       summary_json,failure_json,policies_json,created_at)
      VALUES
      ('tlsr_1','u_1','example.test','google.com','t1',${NOW - 86_400_000},${NOW - 86_400_000},
       '{"total-successful-session-count":10,"total-failure-session-count":2}',
       '[{"result-type":"certificate-expired"}]','[]',0);
  `);
}

beforeEach(() => {
  db = openDb();
  seed();
  env = { DB: d1(db) } as unknown as Env;
});

afterEach(() => db.close());

async function get(path: string, method = "GET") {
  const req = new Request(`https://worker.test${path}`, { method });
  const res = await handleReports(new URL(req.url), req, env, USER);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("DMARC summary", () => {
  it("aggregates by domain and builds timeseries", async () => {
    const { status, body } = await get("/api/v1/reports/dmarc?days=30");
    expect(status).toBe(200);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data[0]).toMatchObject({
      domain: "other.test",
      messages: 10,
      passed: 10,
      failed: 0,
    });
    expect(data[1]).toMatchObject({
      domain: "example.test",
      messages: 8,
      passed: 5,
      failed: 3,
      quarantined: 2,
      rejected: 1,
    });
    expect((body.timeseries as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect((body.reports as unknown[]).length).toBe(2);
  });

  it("filters by domain", async () => {
    const { body } = await get("/api/v1/reports/dmarc?days=30&domain=example.test");
    const data = body.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]!.domain).toBe("example.test");
  });
});

describe("TLS-RPT summary", () => {
  it("reads the hyphenated summary keys", async () => {
    const { status, body } = await get("/api/v1/reports/tls-rpt?days=30");
    expect(status).toBe(200);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data[0]).toMatchObject({
      domain: "example.test",
      reports: 1,
      success: 10,
      failures: 2,
    });
    const reports = body.reports as Array<Record<string, unknown>>;
    expect(reports[0]).toMatchObject({ success: 10, failures: 2 });
    expect((reports[0]!.failure_details as unknown[]).length).toBe(1);
  });
});

describe("reports API", () => {
  it("rejects non-GET", async () => {
    expect((await get("/api/v1/reports/dmarc", "POST")).status).toBe(404);
  });
});
