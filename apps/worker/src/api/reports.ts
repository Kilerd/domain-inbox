// Deliverability dashboard: DMARC aggregate and TLS-RPT summaries over the
// parsed report tables. Cookie-authenticated (SPA); scoped per owner.

import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";

const DAY_MS = 86_400_000;

function iso(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function daysParam(url: URL): number {
  const raw = parseInt(url.searchParams.get("days") ?? "30", 10);
  return Math.min(Math.max(Number.isFinite(raw) ? raw : 30, 1), 365);
}

export async function handleReports(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  if (req.method !== "GET") {
    return httpError.notFound(`reports route ${url.pathname} not found`);
  }
  const path = url.pathname.replace(/^\/api\/v1\/reports/, "");
  if (path === "/dmarc") return dmarc(url, env, user);
  if (path === "/tls-rpt") return tlsRpt(url, env, user);
  return httpError.notFound(`reports route ${path} not found`);
}

async function dmarc(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const days = daysParam(url);
  const since = Date.now() - days * DAY_MS;
  const domain = url.searchParams.get("domain");
  const domainFilter = domain ? " AND r.policy_domain = ?" : "";
  const baseBinds: Array<string | number> = [user.id, since];
  if (domain) baseBinds.push(domain.toLowerCase());

  const byDomain = await env.DB
    .prepare(
      `SELECT r.policy_domain AS domain,
              COUNT(DISTINCT r.id) AS reports,
              COALESCE(SUM(rec.count), 0) AS messages,
              COALESCE(SUM(CASE WHEN rec.dkim = 'pass' OR rec.spf = 'pass'
                                THEN rec.count ELSE 0 END), 0) AS passed,
              COALESCE(SUM(CASE WHEN rec.dkim != 'pass' AND rec.spf != 'pass'
                                THEN rec.count ELSE 0 END), 0) AS failed,
              COALESCE(SUM(CASE WHEN rec.disposition = 'quarantine'
                                THEN rec.count ELSE 0 END), 0) AS quarantined,
              COALESCE(SUM(CASE WHEN rec.disposition = 'reject'
                                THEN rec.count ELSE 0 END), 0) AS rejected,
              MAX(r.date_end) AS last_report_at
       FROM dmarc_reports r
       LEFT JOIN dmarc_records rec ON rec.report_id = r.id
       WHERE r.owner_id = ? AND r.date_end >= ?${domainFilter}
       GROUP BY r.policy_domain
       ORDER BY messages DESC`,
    )
    .bind(...baseBinds)
    .all<{
      domain: string;
      reports: number;
      messages: number;
      passed: number;
      failed: number;
      quarantined: number;
      rejected: number;
      last_report_at: number | null;
    }>();

  const timeseries = await env.DB
    .prepare(
      `SELECT date(r.date_end / 1000, 'unixepoch') AS day,
              COALESCE(SUM(rec.count), 0) AS messages,
              COALESCE(SUM(CASE WHEN rec.dkim != 'pass' AND rec.spf != 'pass'
                                THEN rec.count ELSE 0 END), 0) AS failed,
              COALESCE(SUM(CASE WHEN rec.disposition = 'quarantine'
                                THEN rec.count ELSE 0 END), 0) AS quarantined,
              COALESCE(SUM(CASE WHEN rec.disposition = 'reject'
                                THEN rec.count ELSE 0 END), 0) AS rejected
       FROM dmarc_reports r
       LEFT JOIN dmarc_records rec ON rec.report_id = r.id
       WHERE r.owner_id = ? AND r.date_end >= ?${domainFilter}
       GROUP BY day
       ORDER BY day`,
    )
    .bind(...baseBinds)
    .all<{
      day: string;
      messages: number;
      failed: number;
      quarantined: number;
      rejected: number;
    }>();

  const reports = await env.DB
    .prepare(
      `SELECT r.id, r.policy_domain AS domain, r.org_name, r.report_id,
              r.date_begin, r.date_end,
              COALESCE(SUM(rec.count), 0) AS messages,
              COALESCE(SUM(CASE WHEN rec.dkim != 'pass' AND rec.spf != 'pass'
                                THEN rec.count ELSE 0 END), 0) AS failed
       FROM dmarc_reports r
       LEFT JOIN dmarc_records rec ON rec.report_id = r.id
       WHERE r.owner_id = ? AND r.date_end >= ?${domainFilter}
       GROUP BY r.id
       ORDER BY r.date_end DESC
       LIMIT 50`,
    )
    .bind(...baseBinds)
    .all<{
      id: string;
      domain: string;
      org_name: string;
      report_id: string;
      date_begin: number | null;
      date_end: number | null;
      messages: number;
      failed: number;
    }>();

  return Response.json({
    object: "list",
    days,
    data: (byDomain.results ?? []).map((r) => ({
      ...r,
      last_report_at: iso(r.last_report_at),
    })),
    timeseries: timeseries.results ?? [],
    reports: (reports.results ?? []).map((r) => ({
      ...r,
      date_begin: iso(r.date_begin),
      date_end: iso(r.date_end),
    })),
  });
}

async function tlsRpt(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const days = daysParam(url);
  const since = Date.now() - days * DAY_MS;
  const domain = url.searchParams.get("domain");
  const domainFilter = domain ? " AND policy_domain = ?" : "";
  const binds: Array<string | number> = [user.id, since];
  if (domain) binds.push(domain.toLowerCase());

  const byDomain = await env.DB
    .prepare(
      `SELECT COALESCE(policy_domain, '(unknown)') AS domain,
              COUNT(*) AS reports,
              COALESCE(SUM(CAST(json_extract(summary_json, '$."total-successful-session-count"') AS INTEGER)), 0) AS success,
              COALESCE(SUM(CAST(json_extract(summary_json, '$."total-failure-session-count"') AS INTEGER)), 0) AS failures,
              MAX(date_end) AS last_report_at
       FROM tls_rpt_reports
       WHERE owner_id = ? AND date_end >= ?${domainFilter}
       GROUP BY policy_domain
       ORDER BY failures DESC`,
    )
    .bind(...binds)
    .all<{
      domain: string;
      reports: number;
      success: number;
      failures: number;
      last_report_at: number | null;
    }>();

  const reports = await env.DB
    .prepare(
      `SELECT id, COALESCE(policy_domain, '(unknown)') AS domain,
              org_name, report_id, date_begin, date_end,
              summary_json, failure_json
       FROM tls_rpt_reports
       WHERE owner_id = ? AND date_end >= ?${domainFilter}
       ORDER BY date_end DESC
       LIMIT 50`,
    )
    .bind(...binds)
    .all<{
      id: string;
      domain: string;
      org_name: string;
      report_id: string;
      date_begin: number | null;
      date_end: number | null;
      summary_json: string | null;
      failure_json: string | null;
    }>();

  return Response.json({
    object: "list",
    days,
    data: (byDomain.results ?? []).map((r) => ({
      ...r,
      last_report_at: iso(r.last_report_at),
    })),
    reports: (reports.results ?? []).map((r) => {
      let summary: Record<string, unknown> = {};
      let failures: unknown[] = [];
      try {
        summary = JSON.parse(r.summary_json ?? "{}") as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      try {
        const parsed = JSON.parse(r.failure_json ?? "[]") as unknown;
        failures = Array.isArray(parsed) ? parsed : [];
      } catch {
        /* ignore */
      }
      return {
        id: r.id,
        domain: r.domain,
        org_name: r.org_name,
        report_id: r.report_id,
        date_begin: iso(r.date_begin),
        date_end: iso(r.date_end),
        success: Number(summary["total-successful-session-count"] ?? 0),
        failures: Number(summary["total-failure-session-count"] ?? 0),
        failure_details: failures,
      };
    }),
  });
}
