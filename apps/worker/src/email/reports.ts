// DMARC aggregate (RFC 7489) and TLS-RPT (RFC 8460) report ingestion.
// Report attachments arrive as XML/JSON, usually gzip- or zip-compressed.

import { XMLParser } from "fast-xml-parser";
import { gunzipSync, unzipSync } from "fflate";
import type { Env } from "../env";
import { newId } from "../ids";
import { log } from "../utils/log";

export interface ReportAttachment {
  filename?: string;
  mimeType?: string;
  content: ArrayBuffer | Uint8Array;
}

interface DmarcRecordData {
  sourceIp: string | null;
  count: number;
  disposition: string | null;
  dkim: string | null;
  spf: string | null;
  headerFrom: string | null;
  envelopeFrom: string | null;
}

export interface DmarcReportData {
  policyDomain: string;
  orgName: string;
  reportId: string;
  dateBegin: number | null;
  dateEnd: number | null;
  policy: unknown;
  records: DmarcRecordData[];
}

export interface TlsRptData {
  policyDomain: string | null;
  orgName: string;
  reportId: string;
  dateBegin: number | null;
  dateEnd: number | null;
  summary: unknown;
  failures: unknown;
  policies: unknown;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: true,
});

function toUint8(content: ArrayBuffer | Uint8Array): Uint8Array {
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function toMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function arr<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Parse a DMARC aggregate XML document. Exported for tests. */
export function parseDmarcXml(xml: string): DmarcReportData | null {
  let doc: Record<string, unknown>;
  try {
    doc = xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }
  const feedback = doc.feedback as Record<string, unknown> | undefined;
  if (!feedback) return null;

  const meta = (feedback.report_metadata ?? {}) as Record<string, unknown>;
  const range = (meta.date_range ?? {}) as Record<string, unknown>;
  const published = (feedback.policy_published ?? {}) as Record<string, unknown>;
  const policyDomain = str(published.domain);
  if (!policyDomain) return null;

  const orgName = str(meta.org_name) ?? "unknown";
  const dateBegin = toMs(range.begin);
  const dateEnd = toMs(range.end);
  const reportId =
    str(meta.report_id) ?? `${orgName}:${policyDomain}:${dateBegin ?? 0}:${dateEnd ?? 0}`;

  const records: DmarcRecordData[] = arr(
    feedback.record as Record<string, unknown> | Record<string, unknown>[] | undefined,
  ).map((rec) => {
    const row = (rec.row ?? {}) as Record<string, unknown>;
    const evaluated = (row.policy_evaluated ?? {}) as Record<string, unknown>;
    const ids = (rec.identifiers ?? {}) as Record<string, unknown>;
    return {
      sourceIp: str(row.source_ip),
      count: Math.max(0, Math.trunc(Number(row.count ?? 0)) || 0),
      disposition: str(evaluated.disposition),
      dkim: str(evaluated.dkim),
      spf: str(evaluated.spf),
      headerFrom: str(ids.header_from),
      envelopeFrom: str(ids.envelope_from),
    };
  });

  return {
    policyDomain,
    orgName,
    reportId,
    dateBegin,
    dateEnd,
    policy: published,
    records,
  };
}

/** Parse a TLS-RPT JSON document. Exported for tests. */
export function parseTlsRptJson(json: string): TlsRptData | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const orgName = str(doc["organization-name"]);
  if (!orgName) return null;

  const range = (doc["date-range"] ?? {}) as Record<string, unknown>;
  const beginRaw = range["start-datetime"];
  const endRaw = range["end-datetime"];
  const dateBegin =
    typeof beginRaw === "string" ? Date.parse(beginRaw) || null : null;
  const dateEnd = typeof endRaw === "string" ? Date.parse(endRaw) || null : null;

  const policies = arr(doc.policies as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const policyDomain =
    policies
      .map((p) => str((p.policy as Record<string, unknown> | undefined)?.domain))
      .find((d): d is string => Boolean(d)) ?? null;

  const reportId =
    str(doc["report-id"]) ??
    `${orgName}:${policyDomain ?? "unknown"}:${dateBegin ?? 0}:${dateEnd ?? 0}`;

  return {
    policyDomain,
    orgName,
    reportId,
    dateBegin,
    dateEnd,
    summary: doc.summary ?? null,
    failures: doc["failure-details"] ?? null,
    policies,
  };
}

function decompress(
  filename: string,
  mime: string,
  bytes: Uint8Array,
): Array<{ name: string; bytes: Uint8Array }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".gz") || mime.includes("gzip")) {
    try {
      return [{ name: lower.replace(/\.gz$/, ""), bytes: gunzipSync(bytes) }];
    } catch {
      return [];
    }
  }
  if (lower.endsWith(".zip") || mime.includes("zip")) {
    try {
      return Object.entries(unzipSync(bytes)).map(([name, data]) => ({
        name,
        bytes: data,
      }));
    } catch {
      return [];
    }
  }
  return [{ name: lower, bytes }];
}

async function domainIds(env: Env, ownerId: string): Promise<Map<string, string>> {
  const res = await env.DB
    .prepare(`SELECT id, domain FROM domains WHERE owner_id = ?1`)
    .bind(ownerId)
    .all<{ id: string; domain: string }>();
  return new Map((res.results ?? []).map((d) => [d.domain.toLowerCase(), d.id]));
}

async function storeDmarc(
  env: Env,
  ownerId: string,
  data: DmarcReportData,
  domainId: string | null,
): Promise<boolean> {
  const existing = await env.DB
    .prepare(
      `SELECT id FROM dmarc_reports WHERE owner_id = ?1 AND org_name = ?2 AND report_id = ?3`,
    )
    .bind(ownerId, data.orgName, data.reportId)
    .first<{ id: string }>();
  if (existing) return false;

  const id = newId.dmarcReport();
  await env.DB
    .prepare(
      `INSERT INTO dmarc_reports
         (id, owner_id, domain_id, policy_domain, org_name, report_id,
          date_begin, date_end, policy_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      id,
      ownerId,
      domainId,
      data.policyDomain.toLowerCase(),
      data.orgName,
      data.reportId,
      data.dateBegin,
      data.dateEnd,
      JSON.stringify(data.policy),
      Date.now(),
    )
    .run();

  for (const rec of data.records) {
    await env.DB
      .prepare(
        `INSERT INTO dmarc_records
           (id, report_id, source_ip, count, disposition, dkim, spf,
            header_from, envelope_from)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        newId.dmarcRecord(),
        id,
        rec.sourceIp,
        rec.count,
        rec.disposition,
        rec.dkim,
        rec.spf,
        rec.headerFrom,
        rec.envelopeFrom,
      )
      .run();
  }
  return true;
}

async function storeTls(
  env: Env,
  ownerId: string,
  data: TlsRptData,
  domainId: string | null,
): Promise<boolean> {
  const existing = await env.DB
    .prepare(
      `SELECT id FROM tls_rpt_reports WHERE owner_id = ?1 AND org_name = ?2 AND report_id = ?3`,
    )
    .bind(ownerId, data.orgName, data.reportId)
    .first<{ id: string }>();
  if (existing) return false;

  await env.DB
    .prepare(
      `INSERT INTO tls_rpt_reports
         (id, owner_id, domain_id, policy_domain, org_name, report_id,
          date_begin, date_end, summary_json, failure_json, policies_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      newId.tlsRpt(),
      ownerId,
      domainId,
      data.policyDomain?.toLowerCase() ?? null,
      data.orgName,
      data.reportId,
      data.dateBegin,
      data.dateEnd,
      JSON.stringify(data.summary),
      JSON.stringify(data.failures),
      JSON.stringify(data.policies),
      Date.now(),
    )
    .run();
  return true;
}

/**
 * Inspect message attachments for DMARC/TLS-RPT reports. Malformed reports are
 * logged and skipped; they must never fail the inbound message.
 */
export async function processReportAttachments(
  env: Env,
  ownerId: string,
  attachments: ReportAttachment[],
): Promise<{ dmarc: number; tls: number }> {
  let dmarc = 0;
  let tls = 0;
  const candidates = attachments.filter((a) => {
    const name = (a.filename ?? "").toLowerCase();
    const mime = (a.mimeType ?? "").toLowerCase();
    return (
      /\.(xml|json)(\.gz|\.zip)?$/.test(name) ||
      /xml|json|gzip|zip/.test(mime)
    );
  });
  if (candidates.length === 0) return { dmarc, tls };

  const domains = await domainIds(env, ownerId);

  for (const attachment of candidates) {
    const name = attachment.filename ?? "";
    const mime = (attachment.mimeType ?? "").toLowerCase();
    const bytes = toUint8(attachment.content);
    // Report attachments are tiny; cap before decompressing/parsing.
    if (bytes.byteLength > 10 * 1024 * 1024) continue;
    const entries = decompress(name, mime, bytes);
    for (const entry of entries) {
      if (entry.bytes.byteLength > 5 * 1024 * 1024) continue;
      const entryName = entry.name.toLowerCase();
      const text = new TextDecoder("utf-8", {
        fatal: false,
        ignoreBOM: false,
      }).decode(entry.bytes);
      if (text.length > 2_000_000) continue;
      try {
        if (entryName.endsWith(".xml") || text.trimStart().startsWith("<")) {
          const data = parseDmarcXml(text);
          if (data) {
            const domainId = domains.get(data.policyDomain.toLowerCase()) ?? null;
            if (await storeDmarc(env, ownerId, data, domainId)) dmarc += 1;
          }
        } else if (entryName.endsWith(".json") || text.trimStart().startsWith("{")) {
          const data = parseTlsRptJson(text);
          if (data) {
            const domainId = data.policyDomain
              ? domains.get(data.policyDomain.toLowerCase()) ?? null
              : null;
            if (await storeTls(env, ownerId, data, domainId)) tls += 1;
          }
        }
      } catch (err) {
        log.warn("report.parse_failed", {
          filename: attachment.filename ?? null,
          entry: entry.name,
          error: String(err),
        });
      }
    }
  }
  if (dmarc || tls) log.info("report.ingested", { dmarc, tls });
  return { dmarc, tls };
}
