// Resend-compatible receiving API: programs read inbound mail with an
// `emails.read` bearer key instead of driving the SPA.
//
//   GET /api/v1/emails/receiving                 list received messages
//   GET /api/v1/emails/receiving/:id             parsed body, headers, attachments
//   GET /api/v1/emails/receiving/:id/raw         original MIME
//   GET /api/v1/emails/receiving/:id/attachments/:attachment_id
//
// Domain-scoped keys only see messages from the domains in their scope.

import PostalMime from "postal-mime";
import type { Env } from "../env";
import { httpError } from "../http";
import type { ApiKeyAuth } from "./apikey_auth";

const MAX_LIMIT = 100;

interface ReceivedRow {
  id: string;
  thread_id: string | null;
  domain_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number | null;
  rfc822_message_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  has_attachments: number;
  attachment_count: number;
  size_bytes: number | null;
  r2_key: string | null;
}

interface AttachmentRow {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  content_id: string | null;
  is_inline: number;
  r2_key: string;
}

function jsonAddrs(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((a): a is string => typeof a === "string")
      : [];
  } catch {
    return [];
  }
}

function iso(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function baseShape(row: ReceivedRow) {
  return {
    object: "email",
    id: row.id,
    thread_id: row.thread_id,
    from: row.from_addr,
    from_name: row.from_name,
    to: jsonAddrs(row.to_json),
    cc: jsonAddrs(row.cc_json),
    bcc: jsonAddrs(row.bcc_json),
    subject: row.subject,
    snippet: row.snippet,
    created_at: iso(row.received_at),
    message_id: row.rfc822_message_id,
    in_reply_to: row.in_reply_to,
    references: jsonAddrs(row.references_json),
    has_attachments: Boolean(row.has_attachments),
    attachment_count: row.attachment_count,
    size_bytes: row.size_bytes,
  };
}

function attachmentShape(row: AttachmentRow, messageId: string) {
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size: row.size_bytes,
    content_id: row.content_id,
    is_inline: Boolean(row.is_inline),
    download_url: `/api/v1/emails/receiving/${messageId}/attachments/${row.id}`,
  };
}

const COLUMNS = `m.id, m.thread_id, m.domain_id, m.from_addr, m.from_name,
  m.to_json, m.cc_json, m.bcc_json, m.subject, m.snippet, m.received_at,
  m.rfc822_message_id, m.in_reply_to, m.references_json,
  m.has_attachments, m.attachment_count, m.size_bytes, m.r2_key`;

/**
 * Resolve a key's domain_scope to domain ids. Null means "all domains";
 * an empty array means the key is scoped to nothing.
 */
async function scopeDomainIds(
  env: Env,
  key: ApiKeyAuth,
): Promise<string[] | null> {
  if (!key.domain_scope || key.domain_scope.length === 0) return null;
  const ph = key.domain_scope.map((_, i) => `?${i + 2}`).join(",");
  const res = await env.DB
    .prepare(
      `SELECT id FROM domains
       WHERE owner_id = ?1 AND (id IN (${ph}) OR domain IN (${ph}))`,
    )
    .bind(key.user_id, ...key.domain_scope)
    .all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}

function inScope(domainId: string | null, allowed: string[] | null): boolean {
  return allowed === null || (domainId !== null && allowed.includes(domainId));
}

export async function handleReceiving(
  url: URL,
  req: Request,
  env: Env,
  key: ApiKeyAuth,
): Promise<Response> {
  if (!key.scopes.includes("emails.read")) {
    return httpError.forbidden("API key lacks emails.read scope");
  }
  if (req.method !== "GET") {
    return httpError.notFound(`receiving route ${url.pathname} not found`);
  }

  const path = url.pathname.replace(/^\/api\/v1\/emails\/receiving/, "");
  if (path === "" || path === "/") return listReceived(url, env, key);

  const raw = path.match(/^\/([^/]+)\/raw$/);
  if (raw) return getRaw(env, key, raw[1]!);

  const att = path.match(/^\/([^/]+)\/attachments\/([^/]+)$/);
  if (att) return getAttachment(env, key, att[1]!, att[2]!);

  const one = path.match(/^\/([^/]+)$/);
  if (one) return getReceived(env, key, one[1]!);

  return httpError.notFound(`receiving route ${path} not found`);
}

async function findReceived(
  env: Env,
  key: ApiKeyAuth,
  id: string,
): Promise<ReceivedRow | null> {
  const allowed = await scopeDomainIds(env, key);
  if (allowed !== null && allowed.length === 0) return null;
  const row = await env.DB
    .prepare(
      `SELECT ${COLUMNS} FROM messages m
       WHERE m.id = ?1 AND m.owner_id = ?2
         AND m.direction = 'inbound' AND m.parse_status = 'parsed'`,
    )
    .bind(id, key.user_id)
    .first<ReceivedRow>();
  if (!row) return null;
  return inScope(row.domain_id, allowed) ? row : null;
}

async function listReceived(
  url: URL,
  env: Env,
  key: ApiKeyAuth,
): Promise<Response> {
  const allowed = await scopeDomainIds(env, key);
  if (allowed !== null && allowed.length === 0) {
    return Response.json({ object: "list", has_more: false, next_cursor: null, data: [] });
  }

  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), MAX_LIMIT);
  const cursor = url.searchParams.get("cursor");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const subject = url.searchParams.get("subject");
  const createdAfter = url.searchParams.get("created_after");
  const createdBefore = url.searchParams.get("created_before");

  const where: string[] = [
    "m.owner_id = ?1",
    "m.direction = 'inbound'",
    "m.parse_status = 'parsed'",
  ];
  const binds: Array<string | number> = [key.user_id];

  if (allowed !== null) {
    where.push(`m.domain_id IN (${allowed.map(() => "?").join(",")})`);
    binds.push(...allowed);
  }
  if (from) {
    where.push(`m.from_addr LIKE ? ESCAPE '\\'`);
    binds.push(`%${from.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (to) {
    where.push(`m.to_json LIKE ? ESCAPE '\\'`);
    binds.push(`%${to.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (subject) {
    where.push(`m.subject LIKE ? ESCAPE '\\'`);
    binds.push(`%${subject.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (createdAfter) {
    const ts = Date.parse(createdAfter);
    if (Number.isNaN(ts)) return httpError.validation("created_after must be ISO8601");
    where.push("m.received_at >= ?");
    binds.push(ts);
  }
  if (createdBefore) {
    const ts = Date.parse(createdBefore);
    if (Number.isNaN(ts)) return httpError.validation("created_before must be ISO8601");
    where.push("m.received_at < ?");
    binds.push(ts);
  }
  if (cursor) {
    const [tsRaw, idRaw] = cursor.split(":");
    const ts = parseInt(tsRaw ?? "", 10);
    if (Number.isNaN(ts) || !idRaw) return httpError.validation("invalid cursor");
    where.push(
      "(m.received_at < ? OR (m.received_at = ? AND m.id < ?))",
    );
    binds.push(ts, ts, idRaw);
  }
  binds.push(limit + 1);

  const res = await env.DB
    .prepare(
      `SELECT ${COLUMNS} FROM messages m
       WHERE ${where.join(" AND ")}
       ORDER BY m.received_at DESC, m.id DESC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<ReceivedRow>();

  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return Response.json({
    object: "list",
    has_more: hasMore,
    next_cursor: hasMore && last ? `${last.received_at}:${last.id}` : null,
    data: page.map(baseShape),
  });
}

async function getReceived(
  env: Env,
  key: ApiKeyAuth,
  id: string,
): Promise<Response> {
  const row = await findReceived(env, key, id);
  if (!row) return httpError.notFound(`received email ${id} not found`);

  const attRes = await env.DB
    .prepare(
      `SELECT id, filename, content_type, size_bytes, content_id, is_inline, r2_key
       FROM attachments WHERE message_id = ?1 ORDER BY rowid`,
    )
    .bind(id)
    .all<AttachmentRow>();

  let text: string | null = null;
  let html: string | null = null;
  const headers: Record<string, string> = {};
  if (row.r2_key) {
    const obj = await env.R2.get(row.r2_key);
    if (obj) {
      try {
        const parsed = await PostalMime.parse(await obj.arrayBuffer());
        text = parsed.text ?? null;
        html = parsed.html ?? null;
        for (const h of parsed.headers ?? []) {
          headers[h.key.toLowerCase()] = h.value;
        }
      } catch {
        // Keep metadata even when the raw copy cannot be parsed.
      }
    }
  }

  return Response.json({
    ...baseShape(row),
    text,
    html,
    headers,
    raw_url: `/api/v1/emails/receiving/${id}/raw`,
    attachments: (attRes.results ?? []).map((a) => attachmentShape(a, id)),
  });
}

async function getRaw(env: Env, key: ApiKeyAuth, id: string): Promise<Response> {
  const row = await findReceived(env, key, id);
  if (!row) return httpError.notFound(`received email ${id} not found`);
  if (!row.r2_key) return httpError.notFound("raw payload missing");
  const obj = await env.R2.get(row.r2_key);
  if (!obj) return httpError.notFound("raw payload missing in R2");
  return new Response(obj.body, {
    headers: {
      "content-type": "message/rfc822",
      "content-disposition": `attachment; filename="${id}.eml"`,
    },
  });
}

async function getAttachment(
  env: Env,
  key: ApiKeyAuth,
  messageId: string,
  attachmentId: string,
): Promise<Response> {
  const msg = await findReceived(env, key, messageId);
  if (!msg) return httpError.notFound(`received email ${messageId} not found`);

  const row = await env.DB
    .prepare(
      `SELECT id, filename, content_type, size_bytes, content_id, is_inline, r2_key
       FROM attachments WHERE id = ?1 AND message_id = ?2`,
    )
    .bind(attachmentId, messageId)
    .first<AttachmentRow>();
  if (!row) return httpError.notFound(`attachment ${attachmentId} not found`);

  const obj = await env.R2.get(row.r2_key);
  if (!obj) return httpError.notFound("attachment body missing in R2");
  const filename = (row.filename ?? "file").replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(obj.body, {
    headers: {
      "content-type": row.content_type ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

