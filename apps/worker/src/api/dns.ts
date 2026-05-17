// DoH-driven discovery of Cloudflare Email Routing + Sending DNS state.
//
// Cloudflare assigns MX hostnames per-zone (e.g. `isaac.mx.cloudflare.net`,
// `route1.mx.cloudflare.net`, etc) and priorities are also per-zone. So we
// cannot hardcode them — instead, we *discover* what's currently published
// in DNS and present that to the user.
//
// What we check:
//   - MX  records on the apex (any `*.mx.cloudflare.net` host counts)
//   - SPF in any apex TXT containing `include:_spf.mx.cloudflare.net`
//   - DKIM at `cf2024-N._domainkey.<domain>` for N in {1, 2, 3}
//
// Each record's `status` is "verified" if we found a matching live record,
// else "pending".

export type RecordKind = "MX" | "SPF" | "DKIM";

// Each record belongs to one of two service lanes. MX is purely about
// inbound (Email Routing); DKIM is purely about outbound (Email Sending);
// SPF technically authorizes outbound senders, but CF also installs it
// when Routing is enabled because forwarded mail counts as outbound.
export type RecordPurpose = "receive" | "send";

export interface ExpectedRecord {
  record: RecordKind;
  purpose: RecordPurpose;
  name: string;
  type: "MX" | "TXT" | "CNAME";
  value: string;
  ttl: number;
  priority: number | null;
  status: "pending" | "verified" | "failed";
}

const CF_MX_SUFFIX = ".mx.cloudflare.net";
const SPF_FRAGMENT = "include:_spf.mx.cloudflare.net";
const DKIM_SELECTORS = ["cf2024-1", "cf2024-2", "cf2024-3"];

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

async function dohQuery(name: string, type: string): Promise<DohAnswer[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(
    name,
  )}&type=${type}`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) return [];
  const body = (await res.json()) as { Answer?: DohAnswer[] };
  return body.Answer ?? [];
}

function unquoteTxt(data: string): string {
  return data.replace(/(^"|"$)/g, "").replace(/"\s+"/g, "");
}

/**
 * Generic placeholder records, shown only when DNS isn't reachable or the
 * domain is brand new. Once DoH succeeds we replace these with what we
 * actually observed.
 */
export function expectedRecords(_domain: string): ExpectedRecord[] {
  return [
    {
      record: "MX",
      purpose: "receive",
      name: "@",
      type: "MX",
      value: `*${CF_MX_SUFFIX} (assigned by Cloudflare on Email Routing enable)`,
      ttl: 3600,
      priority: null,
      status: "pending",
    },
    {
      record: "SPF",
      purpose: "send",
      name: "@",
      type: "TXT",
      value: `v=spf1 ${SPF_FRAGMENT} ~all`,
      ttl: 3600,
      priority: null,
      status: "pending",
    },
    {
      record: "DKIM",
      purpose: "send",
      name: "cf2024-1._domainkey",
      type: "TXT",
      value: "v=DKIM1; h=sha256; k=rsa; p=… (auto-published by CF Email Sending)",
      ttl: 3600,
      priority: null,
      status: "pending",
    },
  ];
}

/**
 * Live discovery: query DoH for the apex MX/TXT and the DKIM selectors,
 * return one ExpectedRecord per row of real DNS data with status filled in.
 * Falls back to placeholder layout when nothing's published yet.
 */
export async function discoverRecords(domain: string): Promise<ExpectedRecord[]> {
  const [mxAnswers, txtAnswers, ...dkimResults] = await Promise.all([
    dohQuery(domain, "MX"),
    dohQuery(domain, "TXT"),
    ...DKIM_SELECTORS.map((sel) => dohQuery(`${sel}._domainkey.${domain}`, "TXT")),
  ]);

  const out: ExpectedRecord[] = [];

  // MX rows (receive) — emit one row per discovered host.
  let foundMx = false;
  for (const a of mxAnswers) {
    const parts = a.data.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const priority = Number(parts[0]);
    const host = parts[1]!.replace(/\.$/, "");
    const verified = host.toLowerCase().endsWith(CF_MX_SUFFIX);
    out.push({
      record: "MX",
      purpose: "receive",
      name: "@",
      type: "MX",
      value: host,
      ttl: a.TTL,
      priority: Number.isFinite(priority) ? priority : null,
      status: verified ? "verified" : "failed",
    });
    foundMx = true;
  }
  if (!foundMx) {
    out.push({
      record: "MX",
      purpose: "receive",
      name: "@",
      type: "MX",
      value: `*${CF_MX_SUFFIX} (assigned by Cloudflare on Email Routing enable)`,
      ttl: 3600,
      priority: null,
      status: "pending",
    });
  }

  // SPF row (send-side, but also touched by Routing forwarding)
  const spfRecord = txtAnswers
    .map((a) => unquoteTxt(a.data))
    .find((v) => /v=spf1/i.test(v));
  if (spfRecord) {
    out.push({
      record: "SPF",
      purpose: "send",
      name: "@",
      type: "TXT",
      value: spfRecord,
      ttl: 3600,
      priority: null,
      status: spfRecord.toLowerCase().includes(SPF_FRAGMENT) ? "verified" : "failed",
    });
  } else {
    out.push({
      record: "SPF",
      purpose: "send",
      name: "@",
      type: "TXT",
      value: `v=spf1 ${SPF_FRAGMENT} ~all`,
      ttl: 3600,
      priority: null,
      status: "pending",
    });
  }

  // DKIM row (send) — first hit wins; show selector name in the row.
  let dkimEmitted = false;
  for (let i = 0; i < DKIM_SELECTORS.length; i++) {
    const sel = DKIM_SELECTORS[i]!;
    const answers = dkimResults[i] ?? [];
    const value = answers.map((a) => unquoteTxt(a.data)).find((v) => /v=dkim1/i.test(v));
    if (value) {
      out.push({
        record: "DKIM",
        purpose: "send",
        name: `${sel}._domainkey`,
        type: "TXT",
        value,
        ttl: 3600,
        priority: null,
        status: "verified",
      });
      dkimEmitted = true;
      break;
    }
  }
  if (!dkimEmitted) {
    out.push({
      record: "DKIM",
      purpose: "send",
      name: "cf2024-1._domainkey",
      type: "TXT",
      value: "v=DKIM1; h=sha256; k=rsa; p=… (auto-published by CF Email Sending)",
      ttl: 3600,
      priority: null,
      status: "pending",
    });
  }

  return out;
}

/**
 * Receive-side readiness: only the MX record gates this; without MX no
 * mail reaches us. SPF is helpful but not strictly required for receiving.
 */
export function inboundReady(records: ExpectedRecord[]): boolean {
  return records.some((r) => r.record === "MX" && r.status === "verified");
}

/**
 * Send-side readiness: DKIM must be live (Email Sending enabled on the zone).
 * SPF "softened" by `~all` is also expected; together with DKIM, DMARC-style
 * aligned policies authenticate the From address.
 */
export function outboundReady(records: ExpectedRecord[]): boolean {
  const dkim = records.some((r) => r.record === "DKIM" && r.status === "verified");
  const spf = records.some((r) => r.record === "SPF" && r.status === "verified");
  return dkim && spf;
}

// Backward-compat aliases used elsewhere.
export const verifyRecords = discoverRecords;
export const recordsAllVerified = inboundReady;
