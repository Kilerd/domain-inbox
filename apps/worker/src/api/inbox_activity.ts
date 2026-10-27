import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";
import { jsonArr } from "./inbox_shared";
import {
  buildOutboundFilters,
  getOutboundRow,
  listOutboundEvents,
  listOutboundRows,
  shapeOutbound,
} from "./outbound";

// ── Outbound + activity (cookie-auth surface for the SPA) ─────────────────
//
// Same rows as /api/v1/emails (bearer) but driven by the session AuthUser.
// Query, cursor and mapping are shared (./outbound); only the JSON shape
// differs, because the SPA needs display_status and no idempotency_key.

export async function listOutbound(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const page = await listOutboundRows(url, env, user.id);
  if (page instanceof Response) return page;
  return Response.json({
    object: "list",
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
    data: page.rows.map((r) => shapeOutbound(r, "inbox")),
  });
}

interface StatsRow {
  status: string;
  bounce_type: string | null;
  open_count: number;
  click_count: number;
}

export async function outboundStats(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const built = buildOutboundFilters(url, user.id);
  if (built instanceof Response) return built;
  const { sql, binds } = built;
  const res = await env.DB
    .prepare(
      `SELECT status, bounce_type, open_count, click_count
       FROM outbound_messages om WHERE ${sql}`,
    )
    .bind(...binds)
    .all<StatsRow>();
  const rows = res.results ?? [];

  // Buckets follow Resend's vocabulary: delivered means accepted (we treat
  // sent ~ delivered since CF doesn't surface a separate delivered ack).
  let total = 0;
  let delivered = 0;
  let bounced = 0;
  let complained = 0;
  let failed = 0;
  let opened = 0;
  let clicked = 0;
  for (const r of rows) {
    total++;
    if (r.bounce_type === "complaint") complained++;
    else if (r.status === "bounced" || r.bounce_type === "hard") bounced++;
    else if (r.status === "failed") failed++;
    else if (r.status === "sent" || r.status === "delivered") delivered++;
    if (r.open_count > 0) opened++;
    if (r.click_count > 0) clicked++;
  }
  const deliverable = total - failed; // exclude pre-flight failures
  return Response.json({
    total,
    delivered,
    bounced,
    complained,
    failed,
    opened,
    clicked,
    deliverability_rate: deliverable > 0 ? delivered / deliverable : 0,
    bounce_rate: deliverable > 0 ? bounced / deliverable : 0,
    complain_rate: deliverable > 0 ? complained / deliverable : 0,
    open_rate: delivered > 0 ? opened / delivered : 0,
    click_rate: delivered > 0 ? clicked / delivered : 0,
  });
}

interface TimeseriesRow {
  created_at: number;
  status: string;
  bounce_type: string | null;
  open_count: number;
  click_count: number;
}

export async function outboundTimeseries(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const built = buildOutboundFilters(url, user.id);
  if (built instanceof Response) return built;
  const { sql, binds } = built;

  // Compute a from/to window from the filters when provided, else default to
  // last 15 days — same default Resend shows.
  const fromParam = url.searchParams.get("created_after");
  const toParam = url.searchParams.get("created_before");
  const to = toParam ? Date.parse(toParam) : Date.now();
  const from = fromParam ? Date.parse(fromParam) : to - 15 * 86_400_000;

  const res = await env.DB
    .prepare(
      `SELECT created_at, status, bounce_type, open_count, click_count
       FROM outbound_messages om WHERE ${sql} ORDER BY created_at ASC`,
    )
    .bind(...binds)
    .all<TimeseriesRow>();
  const rows = res.results ?? [];

  // Bucket by UTC day. Pre-seed every day in the window so the chart x-axis
  // is gap-free even with sparse data.
  const dayMs = 86_400_000;
  function dayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  const buckets = new Map<
    string,
    { delivered: number; bounced: number; complained: number; opened: number; clicked: number; sent: number }
  >();
  for (let t = from; t <= to + dayMs; t += dayMs) {
    buckets.set(dayKey(t), {
      delivered: 0,
      bounced: 0,
      complained: 0,
      opened: 0,
      clicked: 0,
      sent: 0,
    });
  }
  for (const r of rows) {
    const k = dayKey(r.created_at);
    const b = buckets.get(k);
    if (!b) continue;
    b.sent++;
    if (r.bounce_type === "complaint") b.complained++;
    else if (r.status === "bounced" || r.bounce_type === "hard") b.bounced++;
    else if (r.status === "sent" || r.status === "delivered") b.delivered++;
    if (r.open_count > 0) b.opened++;
    if (r.click_count > 0) b.clicked++;
  }
  return Response.json({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    granularity: "day",
    series: [...buckets.entries()].map(([day, v]) => ({ day, ...v })),
  });
}

interface InboundListRow {
  id: string;
  rfc822_message_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number | null;
  size_bytes: number | null;
  has_attachments: number;
  attachment_count: number;
  thread_id: string | null;
}

export async function listInbound(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const q = url.searchParams.get("q");
  const domain = url.searchParams.get("domain");
  const createdAfter = url.searchParams.get("created_after");
  const createdBefore = url.searchParams.get("created_before");
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100);
  const cursor = url.searchParams.get("cursor");

  const filters: string[] = ["owner_id = ?1", "direction = 'inbound'", "parse_status != 'duplicate'"];
  const binds: Array<string | number> = [user.id];
  if (q) {
    filters.push(
      `(subject LIKE ?${binds.length + 1} OR from_addr LIKE ?${binds.length + 1})`,
    );
    binds.push(`%${q}%`);
  }
  if (domain) {
    // to_json is a JSON array string; LIKE %@domain% works since the array
    // values include the domain literal.
    filters.push(`to_json LIKE ?${binds.length + 1}`);
    binds.push(`%@${domain}%`);
  }
  if (createdAfter) {
    const ts = Date.parse(createdAfter);
    if (Number.isNaN(ts)) return httpError.validation("created_after must be ISO8601");
    filters.push(`received_at >= ?${binds.length + 1}`);
    binds.push(ts);
  }
  if (createdBefore) {
    const ts = Date.parse(createdBefore);
    if (Number.isNaN(ts)) return httpError.validation("created_before must be ISO8601");
    filters.push(`received_at < ?${binds.length + 1}`);
    binds.push(ts);
  }
  if (cursor) {
    const [tsRaw, idRaw] = cursor.split(":");
    const ts = parseInt(tsRaw ?? "", 10);
    if (Number.isNaN(ts) || !idRaw) return httpError.validation("invalid cursor");
    filters.push(
      `(received_at < ?${binds.length + 1} OR (received_at = ?${binds.length + 1} AND id < ?${binds.length + 2}))`,
    );
    binds.push(ts, idRaw);
  }

  const res = await env.DB
    .prepare(
      `SELECT id, rfc822_message_id, from_addr, from_name, to_json,
              subject, snippet, received_at, size_bytes,
              has_attachments, attachment_count, thread_id
       FROM messages WHERE ${filters.join(" AND ")}
       ORDER BY received_at DESC, id DESC
       LIMIT ${limit + 1}`,
    )
    .bind(...binds)
    .all<InboundListRow>();
  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const next = hasMore && page.length
    ? `${page[page.length - 1]!.received_at}:${page[page.length - 1]!.id}`
    : null;

  return Response.json({
    object: "list",
    has_more: hasMore,
    next_cursor: next,
    data: page.map((r) => ({
      id: r.id,
      rfc822_message_id: r.rfc822_message_id,
      from: r.from_addr ? { address: r.from_addr, name: r.from_name } : null,
      to: jsonArr(r.to_json),
      subject: r.subject,
      snippet: r.snippet,
      received_at: r.received_at ? new Date(r.received_at).toISOString() : null,
      size_bytes: r.size_bytes,
      has_attachments: Boolean(r.has_attachments),
      attachment_count: r.attachment_count,
      thread_id: r.thread_id,
    })),
  });
}

export async function getOutbound(env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await getOutboundRow(env, user.id, id);
  if (!row) return httpError.notFound(`outbound ${id} not found`);
  return Response.json(shapeOutbound(row, "inbox"));
}

export async function getOutboundEvents(env: Env, user: AuthUser, id: string): Promise<Response> {
  const data = await listOutboundEvents(env, user.id, id);
  if (!data) return httpError.notFound(`outbound ${id} not found`);
  return Response.json({ object: "list", email_id: id, data });
}

export async function listEvents(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const type = url.searchParams.get("type");
  const emailId = url.searchParams.get("email_id");
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
  const cursor = url.searchParams.get("cursor");

  const filters: string[] = ["owner_id = ?1"];
  const binds: Array<string | number> = [user.id];
  if (type) {
    filters.push(`type = ?${binds.length + 1}`);
    binds.push(type);
  }
  if (emailId) {
    filters.push(`(outbound_id = ?${binds.length + 1} OR email_id = ?${binds.length + 1})`);
    binds.push(emailId);
  }
  if (cursor) {
    const [tsRaw, idRaw] = cursor.split(":");
    const ts = parseInt(tsRaw ?? "", 10);
    if (Number.isNaN(ts) || !idRaw) return httpError.validation("invalid cursor");
    filters.push(
      `(created_at < ?${binds.length + 1} OR (created_at = ?${binds.length + 1} AND id < ?${binds.length + 2}))`,
    );
    binds.push(ts, idRaw);
  }

  const res = await env.DB
    .prepare(
      `SELECT id, type, email_id, outbound_id, payload_json, created_at
       FROM events WHERE ${filters.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`,
    )
    .bind(...binds)
    .all<{
      id: string;
      type: string;
      email_id: string | null;
      outbound_id: string | null;
      payload_json: string;
      created_at: number;
    }>();
  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const next = hasMore && page.length
    ? `${page[page.length - 1]!.created_at}:${page[page.length - 1]!.id}`
    : null;
  return Response.json({
    object: "list",
    has_more: hasMore,
    next_cursor: next,
    data: page.map((r) => ({
      id: r.id,
      type: r.type,
      email_id: r.email_id ?? r.outbound_id,
      created_at: new Date(r.created_at).toISOString(),
      data: JSON.parse(r.payload_json),
    })),
  });
}
