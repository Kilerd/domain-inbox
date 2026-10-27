// Shared outbound read model.
//
// The same outbound_messages rows are served by two surfaces:
//   - /api/v1/emails…     Resend-compatible (bearer API key)
//   - /api/inbox/outbound… the SPA's activity view (cookie session)
//
// The auth and response shapes differ on purpose, but the query, cursor
// pagination and row→JSON mapping must not. They used to be implemented
// twice; keeping one core here means a new filter or column lands in both.

import type { Env } from "../env";
import { httpError } from "../http";

export interface OutboundRow {
  id: string;
  status: string;
  created_at: number;
  sent_at: number | null;
  scheduled_at: number | null;
  bounced_at: number | null;
  bounce_type: string | null;
  bounce_diag: string | null;
  last_error: string | null;
  template_id: string | null;
  tracking_enabled: number;
  open_count: number;
  click_count: number;
  first_opened_at: number | null;
  last_opened_at: number | null;
  first_clicked_at: number | null;
  last_clicked_at: number | null;
  api_key_id: string | null;
  idempotency_key: string | null;
  test_mode: number;
  request_json: string;
}

const COLUMNS = `om.id, om.status, om.created_at, om.sent_at, om.scheduled_at,
  om.bounced_at, om.bounce_type, om.bounce_diag, om.last_error,
  om.template_id, om.tracking_enabled, om.open_count, om.click_count,
  om.first_opened_at, om.last_opened_at, om.first_clicked_at, om.last_clicked_at,
  om.api_key_id, om.idempotency_key, om.test_mode, om.request_json`;

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms ? iso(ms) : null);

/** The SPA's derived lifecycle label (Resend returns the raw status). */
export function deriveDisplayStatus(r: OutboundRow): string {
  if (r.bounce_type === "complaint") return "complained";
  if (r.status === "bounced" || r.bounce_type === "hard") return "bounced";
  if (r.bounce_type === "soft") return "delivery_delayed";
  if (r.status === "failed") return "failed";
  if (r.status === "canceled") return "canceled";
  if (r.status === "scheduled") return "scheduled";
  if (r.status === "queued" || r.status === "sending") return "queued";
  if (r.click_count > 0) return "clicked";
  if (r.open_count > 0) return "opened";
  if (r.status === "sent" || r.status === "delivered") return "delivered";
  return r.status;
}

export type OutboundShape = "api" | "inbox";

interface OutboundBase {
  id: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  scheduled_at: string | null;
  bounced_at: string | null;
  bounce_type: string | null;
  bounce_diag: string | null;
  last_error: string | null;
  from: unknown;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  subject: unknown;
  template_id: string | null;
  api_key_id: string | null;
  test_mode: boolean;
  tracking: {
    enabled: boolean;
    open_count: number;
    click_count: number;
    first_opened_at: string | null;
    last_opened_at: string | null;
    first_clicked_at: string | null;
    last_clicked_at: string | null;
  };
}

export interface OutboundApiShape extends OutboundBase {
  object: "email";
  idempotency_key: string | null;
}

export interface OutboundInboxShape extends OutboundBase {
  display_status: string;
}

export function shapeOutbound(r: OutboundRow, variant: "api"): OutboundApiShape;
export function shapeOutbound(r: OutboundRow, variant: "inbox"): OutboundInboxShape;
export function shapeOutbound(r: OutboundRow, variant: OutboundShape) {
  const req = JSON.parse(r.request_json) as Record<string, unknown>;
  const base: OutboundBase = {
    id: r.id,
    status: r.status,
    created_at: iso(r.created_at),
    sent_at: isoOrNull(r.sent_at),
    scheduled_at: isoOrNull(r.scheduled_at),
    bounced_at: isoOrNull(r.bounced_at),
    bounce_type: r.bounce_type,
    bounce_diag: r.bounce_diag,
    last_error: r.last_error,
    from: req.from,
    to: req.to,
    cc: req.cc ?? null,
    bcc: req.bcc ?? null,
    subject: req.subject ?? null,
    template_id: r.template_id,
    api_key_id: r.api_key_id,
    test_mode: Boolean(r.test_mode),
    tracking: {
      enabled: Boolean(r.tracking_enabled),
      open_count: r.open_count,
      click_count: r.click_count,
      first_opened_at: isoOrNull(r.first_opened_at),
      last_opened_at: isoOrNull(r.last_opened_at),
      first_clicked_at: isoOrNull(r.first_clicked_at),
      last_clicked_at: isoOrNull(r.last_clicked_at),
    },
  };
  return variant === "api"
    ? { object: "email", ...base, idempotency_key: r.idempotency_key }
    : { ...base, display_status: deriveDisplayStatus(r) };
}

/**
 * Filter clause shared by list/stats/timeseries. `display` is derived in JS,
 * not SQL, so it is intentionally not handled here.
 */
export function buildOutboundFilters(
  url: URL,
  userId: string,
): { sql: string; binds: Array<string | number> } | Response {
  const status = url.searchParams.get("status");
  const domain = url.searchParams.get("domain");
  const apiKey = url.searchParams.get("api_key");
  const q = url.searchParams.get("q");
  const createdAfter = url.searchParams.get("created_after");
  const createdBefore = url.searchParams.get("created_before");

  const filters: string[] = ["om.owner_id = ?1"];
  const binds: Array<string | number> = [userId];
  if (status) {
    filters.push(`om.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (apiKey) {
    filters.push(`om.api_key_id = ?${binds.length + 1}`);
    binds.push(apiKey);
  }
  if (domain) {
    filters.push(`json_extract(om.request_json, '$.from') LIKE ?${binds.length + 1}`);
    binds.push(`%@${domain}%`);
  }
  if (q) {
    filters.push(
      `(json_extract(om.request_json, '$.subject') LIKE ?${binds.length + 1}
        OR json_extract(om.request_json, '$.from') LIKE ?${binds.length + 1}
        OR json_extract(om.request_json, '$.to') LIKE ?${binds.length + 1})`,
    );
    binds.push(`%${q}%`);
  }
  if (createdAfter) {
    const ts = Date.parse(createdAfter);
    if (Number.isNaN(ts)) return httpError.validation("created_after must be ISO8601");
    filters.push(`om.created_at >= ?${binds.length + 1}`);
    binds.push(ts);
  }
  if (createdBefore) {
    const ts = Date.parse(createdBefore);
    if (Number.isNaN(ts)) return httpError.validation("created_before must be ISO8601");
    filters.push(`om.created_at < ?${binds.length + 1}`);
    binds.push(ts);
  }
  return { sql: filters.join(" AND "), binds };
}

export interface OutboundPage {
  rows: OutboundRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Cursor-paginated list, newest first. */
export async function listOutboundRows(
  url: URL,
  env: Env,
  userId: string,
): Promise<OutboundPage | Response> {
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100);
  const cursor = url.searchParams.get("cursor");
  const display = url.searchParams.get("display");

  const built = buildOutboundFilters(url, userId);
  if (built instanceof Response) return built;
  const { sql, binds } = built;
  const filterParts = [sql];

  if (cursor) {
    const [tsRaw, idRaw] = cursor.split(":");
    const ts = parseInt(tsRaw ?? "", 10);
    if (Number.isNaN(ts) || !idRaw) return httpError.validation("invalid cursor");
    filterParts.push(
      `(om.created_at < ?${binds.length + 1} OR (om.created_at = ?${binds.length + 1} AND om.id < ?${binds.length + 2}))`,
    );
    binds.push(ts, idRaw);
  }

  // `display` filters a derived value, so fetch extra rows to keep pages
  // full; bounded so a rare label can't turn into a table scan.
  const fetchLimit = display ? Math.min((limit + 1) * 4, 400) : limit + 1;
  const res = await env.DB
    .prepare(
      `SELECT ${COLUMNS}
       FROM outbound_messages om
       WHERE ${filterParts.join(" AND ")}
       ORDER BY om.created_at DESC, om.id DESC
       LIMIT ${fetchLimit}`,
    )
    .bind(...binds)
    .all<OutboundRow>();

  let rows = res.results ?? [];
  if (display) rows = rows.filter((r) => deriveDisplayStatus(r) === display);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    hasMore,
    nextCursor: hasMore && last ? `${last.created_at}:${last.id}` : null,
  };
}

export async function getOutboundRow(
  env: Env,
  userId: string,
  id: string,
): Promise<OutboundRow | null> {
  return env.DB
    .prepare(
      `SELECT ${COLUMNS} FROM outbound_messages om
       WHERE om.id = ?1 AND om.owner_id = ?2`,
    )
    .bind(id, userId)
    .first<OutboundRow>();
}

export interface OutboundEvent {
  id: string;
  type: string;
  created_at: string;
  data: unknown;
}

/** Events for one outbound id, oldest first; null when it is not ours. */
export async function listOutboundEvents(
  env: Env,
  userId: string,
  id: string,
): Promise<OutboundEvent[] | null> {
  const owns = await env.DB
    .prepare(`SELECT id FROM outbound_messages WHERE id = ?1 AND owner_id = ?2`)
    .bind(id, userId)
    .first<{ id: string }>();
  if (!owns) return null;

  const res = await env.DB
    .prepare(
      `SELECT id, type, payload_json, created_at
       FROM events
       WHERE owner_id = ?1 AND (outbound_id = ?2 OR email_id = ?2)
       ORDER BY created_at ASC`,
    )
    .bind(userId, id)
    .all<{ id: string; type: string; payload_json: string; created_at: number }>();

  return (res.results ?? []).map((r) => ({
    id: r.id,
    type: r.type,
    created_at: iso(r.created_at),
    data: JSON.parse(r.payload_json),
  }));
}
