import PostalMime from "postal-mime";
import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";
import { handleEmailSend } from "./emails";
import { sanitizeEmailHtml } from "./sanitize";

interface ThreadRow {
  id: string;
  subject_normalized: string | null;
  message_count: number;
  unread_count: number;
  participants_json: string | null;
  first_message_at: number;
  last_message_at: number;
  flags_bitmap: number;
  subject: string | null;
  snippet: string | null;
  domain_id: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string | null;
  rfc822_message_id: string | null;
  direction: string;
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number | null;
  sent_at: number | null;
  size_bytes: number | null;
  has_attachments: number;
  attachment_count: number;
  flags_bitmap: number;
  parse_status: string;
  outbound_id?: string | null;
}

interface AttachmentRow {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  content_id: string | null;
  is_inline: number;
}

function jsonArr(s: string | null): string[] {
  if (!s) return [];
  try {
    return JSON.parse(s) as string[];
  } catch {
    return [];
  }
}

function threadShape(t: ThreadRow) {
  return {
    id: t.id,
    subject: t.subject ?? t.subject_normalized ?? "(no subject)",
    participants: jsonArr(t.participants_json),
    message_count: t.message_count,
    unread_count: t.unread_count,
    first_message_at: t.first_message_at,
    last_message_at: t.last_message_at,
    flags_bitmap: t.flags_bitmap,
    snippet: t.snippet,
    domain_id: t.domain_id,
  };
}

function messageShape(m: MessageRow, attachments: AttachmentRow[] = []) {
  return {
    id: m.id,
    thread_id: m.thread_id,
    rfc822_message_id: m.rfc822_message_id,
    direction: m.direction,
    from: m.from_addr ? { address: m.from_addr, name: m.from_name } : null,
    to: jsonArr(m.to_json),
    cc: jsonArr(m.cc_json),
    bcc: jsonArr(m.bcc_json),
    reply_to: m.reply_to,
    subject: m.subject,
    snippet: m.snippet,
    received_at: m.received_at,
    sent_at: m.sent_at,
    size_bytes: m.size_bytes,
    has_attachments: Boolean(m.has_attachments),
    attachment_count: m.attachment_count,
    is_read: Boolean(m.flags_bitmap & 1),
    parse_status: m.parse_status,
    outbound_id: m.outbound_id ?? null,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size_bytes: a.size_bytes,
      content_id: a.content_id,
      is_inline: Boolean(a.is_inline),
    })),
  };
}

export async function handleInbox(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/inbox/, "");

  if (path === "/stream" && req.method === "GET") return openInboxStream(env, user);
  if (path === "/compose" && req.method === "POST") return composeEmail(req, env, user, ctx);
  if (path === "/from-suggestions" && req.method === "GET") return fromSuggestions(env, user);

  if (path === "/threads" && req.method === "GET") return listThreads(url, env, user);
  if (path === "/threads/batch/flags" && req.method === "POST") return batchFlags(req, env, user);

  const tm = path.match(/^\/threads\/([^/]+)\/messages$/);
  if (tm && req.method === "GET") return getThreadMessages(env, user, tm[1]!);

  const tf = path.match(/^\/threads\/([^/]+)\/flags$/);
  if (tf && req.method === "POST") return threadFlags(req, env, user, tf[1]!);

  const mb = path.match(/^\/messages\/([^/]+)\/body$/);
  if (mb && req.method === "GET") return getMessageBody(env, user, mb[1]!);

  const mr = path.match(/^\/messages\/([^/]+)\/read$/);
  if (mr && req.method === "POST") return markRead(env, user, mr[1]!);

  const att = path.match(/^\/attachments\/([^/]+)$/);
  if (att && req.method === "GET") return getAttachment(env, user, att[1]!);

  if (path === "/domains" && req.method === "GET") return listInboxDomains(env, user);
  if (path === "/aliases" && req.method === "GET") return listInboxAliases(url, env, user);

  const ae = path.match(/^\/aliases\/([^/]+)$/);
  if (ae && req.method === "PATCH") return patchAlias(req, env, user, ae[1]!);
  if (ae && req.method === "DELETE") return deleteAlias(env, user, ae[1]!);

  if (path === "/outbound" && req.method === "GET") return listOutbound(url, env, user);
  if (path === "/outbound/stats" && req.method === "GET") return outboundStats(url, env, user);
  if (path === "/outbound/timeseries" && req.method === "GET") return outboundTimeseries(url, env, user);
  const od = path.match(/^\/outbound\/([^/]+)$/);
  if (od && req.method === "GET") return getOutbound(env, user, od[1]!);
  const oe = path.match(/^\/outbound\/([^/]+)\/events$/);
  if (oe && req.method === "GET") return getOutboundEvents(env, user, oe[1]!);

  if (path === "/inbound" && req.method === "GET") return listInbound(url, env, user);
  if (path === "/events" && req.method === "GET") return listEvents(url, env, user);

  return httpError.notFound(`inbox route ${path} not found`);
}

/**
 * Browser-side compose endpoint. Reuses `handleEmailSend` (the Resend-shaped
 * sender) but auth comes from the cookie-session AuthUser instead of a
 * bearer API key. Internally we synthesize an ApiKeyAuth-shaped principal so
 * scope / domain_scope checks pass uniformly.
 */
async function composeEmail(
  req: Request,
  env: Env,
  user: AuthUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  const auth = {
    user_id: user.id,
    key_id: null as unknown as string, // nullable column in outbound_messages
    scopes: ["emails.send", "emails.read"],
    domain_scope: null,
  };
  return handleEmailSend(req, env, auth, ctx);
}

/**
 * From-address suggestions for the compose UI: recent outbound senders plus
 * any explicit aliases the user has access to. Deduped by full address.
 */
async function fromSuggestions(env: Env, user: AuthUser): Promise<Response> {
  const recent = await env.DB
    .prepare(
      `SELECT from_addr, MAX(sent_at) AS used_at
       FROM messages
       WHERE owner_id = ?1 AND direction = 'outbound' AND from_addr IS NOT NULL
       GROUP BY from_addr
       ORDER BY used_at DESC
       LIMIT 10`,
    )
    .bind(user.id)
    .all<{ from_addr: string; used_at: number }>();

  const aliases = await env.DB
    .prepare(
      `SELECT a.full_address AS addr, a.last_message_at AS used_at
       FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE d.owner_id = ?1 AND a.type = 'explicit' AND a.disabled = 0
       ORDER BY a.last_message_at DESC NULLS LAST
       LIMIT 10`,
    )
    .bind(user.id)
    .all<{ addr: string; used_at: number | null }>();

  const seen = new Set<string>();
  const out: { address: string; used_at: number | null }[] = [];
  for (const r of recent.results ?? []) {
    if (!seen.has(r.from_addr)) {
      seen.add(r.from_addr);
      out.push({ address: r.from_addr, used_at: r.used_at });
    }
  }
  for (const a of aliases.results ?? []) {
    if (!seen.has(a.addr)) {
      seen.add(a.addr);
      out.push({ address: a.addr, used_at: a.used_at });
    }
  }
  return Response.json({ object: "list", data: out });
}

async function openInboxStream(env: Env, user: AuthUser): Promise<Response> {
  const encoder = new TextEncoder();
  const key = `inbox:lastUpdate:${user.id}`;
  const stored = await env.KV.get<string>(key, "text");
  let lastSeen = stored ? parseInt(stored, 10) : 0;

  const stream = new ReadableStream({
    async start(controller) {
      const TICK_MS = 2000;
      const MAX_LIFETIME_MS = 4 * 60 * 1000;
      const startedAt = Date.now();
      try {
        controller.enqueue(
          encoder.encode(`event: hello\ndata: ${JSON.stringify({ user_id: user.id, ts: Date.now() })}\n\n`),
        );
        while (Date.now() - startedAt < MAX_LIFETIME_MS) {
          const ts = await env.KV.get<string>(key, "text");
          const current = ts ? parseInt(ts, 10) : 0;
          if (current > lastSeen) {
            lastSeen = current;
            controller.enqueue(
              encoder.encode(`event: new-message\ndata: ${JSON.stringify({ ts: current })}\n\n`),
            );
          } else {
            controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
          }
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

// flags_bitmap bit positions (mirror migration 0003_inbox_v2)
const FLAG_READ = 1;     // bit 0
const FLAG_STARRED = 2;  // bit 1
const FLAG_ARCHIVED = 4; // bit 2
const FLAG_TRASH = 8;    // bit 3
const FLAG_SPAM = 16;    // bit 4

type View = "inbox" | "unread" | "starred" | "archived" | "trash" | "spam" | "sent" | "all";

interface ViewFilter {
  where: string;
  binds: unknown[];
}

function viewClause(view: View): ViewFilter {
  // inbox = not archived, not trash, not spam (the "default" mailbox view)
  switch (view) {
    case "unread":
      return { where: "t.unread_count > 0 AND (t.flags_bitmap & ?) = 0", binds: [FLAG_TRASH | FLAG_SPAM] };
    case "starred":
      return { where: "(t.flags_bitmap & ?) != 0", binds: [FLAG_STARRED] };
    case "archived":
      return { where: "(t.flags_bitmap & ?) != 0", binds: [FLAG_ARCHIVED] };
    case "trash":
      return { where: "(t.flags_bitmap & ?) != 0", binds: [FLAG_TRASH] };
    case "spam":
      return { where: "(t.flags_bitmap & ?) != 0", binds: [FLAG_SPAM] };
    case "sent":
      return {
        where:
          "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.direction = 'outbound')",
        binds: [],
      };
    case "all":
      return { where: "1=1", binds: [] };
    case "inbox":
    default:
      return { where: "(t.flags_bitmap & ?) = 0", binds: [FLAG_ARCHIVED | FLAG_TRASH | FLAG_SPAM] };
  }
}

async function listThreads(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
  const cursorParam = url.searchParams.get("cursor");
  const cursorTs = cursorParam ? parseInt(cursorParam, 10) : Number.MAX_SAFE_INTEGER;
  const view = (url.searchParams.get("view") ?? "inbox") as View;
  const domain = url.searchParams.get("domain");
  const alias = url.searchParams.get("alias");
  const q = url.searchParams.get("q")?.trim() ?? "";

  const filter = viewClause(view);
  const where: string[] = [
    "t.owner_id = ?",
    "t.last_message_at < ?",
    filter.where,
  ];
  const binds: unknown[] = [user.id, cursorTs, ...filter.binds];

  if (domain) {
    where.push("t.domain_id = ?");
    binds.push(domain);
  }
  if (alias) {
    where.push(
      "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.alias_id = ?)",
    );
    binds.push(alias);
  }
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    where.push(
      "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND " +
        "(m.subject LIKE ? OR m.snippet LIKE ? OR m.from_addr LIKE ?))",
    );
    binds.push(like, like, like);
  }
  binds.push(limit + 1);

  const sql = `
    SELECT t.id, t.subject_normalized, t.message_count, t.unread_count,
           t.participants_json, t.first_message_at, t.last_message_at,
           t.flags_bitmap, t.domain_id,
           (SELECT subject FROM messages
              WHERE thread_id = t.id AND parse_status != 'duplicate'
              ORDER BY received_at DESC LIMIT 1) AS subject,
           (SELECT snippet FROM messages
              WHERE thread_id = t.id AND parse_status != 'duplicate'
              ORDER BY received_at DESC LIMIT 1) AS snippet
    FROM threads t
    WHERE ${where.join(" AND ")}
    ORDER BY t.last_message_at DESC
    LIMIT ?`;

  const res = await env.DB.prepare(sql).bind(...binds).all<ThreadRow>();
  const rows = res.results ?? [];
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1]!;
    nextCursor = String(last.last_message_at);
    rows.length = limit;
  }

  return Response.json({
    threads: rows.map(threadShape),
    next_cursor: nextCursor,
  });
}

// ── Navigator stats ───────────────────────────────────────────────────────

async function listInboxDomains(env: Env, user: AuthUser): Promise<Response> {
  const res = await env.DB
    .prepare(
      `SELECT d.id, d.domain,
              (SELECT COUNT(*) FROM threads t
                 WHERE t.owner_id = ?1 AND t.domain_id = d.id
                   AND (t.flags_bitmap & ?2) = 0
                   AND t.unread_count > 0) AS unread_count,
              (SELECT COUNT(*) FROM threads t
                 WHERE t.owner_id = ?1 AND t.domain_id = d.id
                   AND (t.flags_bitmap & ?2) = 0) AS thread_count
       FROM domains d
       WHERE d.owner_id = ?1
       ORDER BY d.created_at DESC`,
    )
    .bind(user.id, FLAG_TRASH | FLAG_SPAM)
    .all<{ id: string; domain: string; unread_count: number; thread_count: number }>();
  return Response.json({
    object: "list",
    data: res.results ?? [],
  });
}

interface AliasListRow {
  id: string;
  domain_id: string;
  full_address: string;
  local_part: string;
  type: string;
  label: string | null;
  disabled: number;
  hidden: number;
  message_count: number;
  unread_count: number;
  last_message_at: number | null;
}

async function listInboxAliases(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const domain = url.searchParams.get("domain");
  const includeQuiet = url.searchParams.get("include_quiet") === "true";

  // We always restrict to aliases the user owns (via the domain).
  const where: string[] = ["d.owner_id = ?"];
  const binds: unknown[] = [user.id];
  if (domain) {
    where.push("(d.id = ? OR d.domain = ?)");
    binds.push(domain, domain);
  }

  let sql = `
    SELECT a.id, a.domain_id, a.full_address, a.local_part, a.type, a.label,
           a.disabled, a.hidden, a.message_count, a.unread_count, a.last_message_at
    FROM aliases a JOIN domains d ON d.id = a.domain_id
    WHERE ${where.join(" AND ")}`;

  if (!includeQuiet) {
    // Default Navigator view hides auto_created aliases that are obviously
    // noise: hidden=1, or zero/one messages with no recent activity.
    sql += ` AND NOT (
      a.hidden = 1
      OR (a.type = 'auto_created'
          AND a.message_count <= 1
          AND (a.last_message_at IS NULL
               OR a.last_message_at < (strftime('%s','now') * 1000) - 7*24*3600*1000))
    )`;
  }
  sql += ` ORDER BY a.last_message_at DESC NULLS LAST, a.local_part`;

  const res = await env.DB.prepare(sql).bind(...binds).all<AliasListRow>();
  return Response.json({
    object: "list",
    data: (res.results ?? []).map((a) => ({
      id: a.id,
      domain_id: a.domain_id,
      address: a.full_address,
      local_part: a.local_part,
      type: a.type,
      label: a.label,
      disabled: Boolean(a.disabled),
      hidden: Boolean(a.hidden),
      message_count: a.message_count,
      unread_count: a.unread_count,
      last_message_at: a.last_message_at,
    })),
  });
}

async function patchAlias(req: Request, env: Env, user: AuthUser, id: string): Promise<Response> {
  let body: { label?: unknown; hidden?: unknown; disabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  // Verify ownership.
  const row = await env.DB
    .prepare(
      `SELECT a.id FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE a.id = ?1 AND d.owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<{ id: string }>();
  if (!row) return httpError.notFound(`alias ${id} not found`);

  const updates: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.label === "string" || body.label === null) {
    updates.push("label = ?");
    binds.push(body.label);
  }
  if (typeof body.hidden === "boolean") {
    updates.push("hidden = ?");
    binds.push(body.hidden ? 1 : 0);
  }
  if (typeof body.disabled === "boolean") {
    updates.push("disabled = ?");
    binds.push(body.disabled ? 1 : 0);
  }
  if (!updates.length) return httpError.validation("no editable fields supplied");
  binds.push(id);
  await env.DB
    .prepare(`UPDATE aliases SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return Response.json({ object: "alias", id, updated: true });
}

async function deleteAlias(env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT a.id, a.type, a.message_count
       FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE a.id = ?1 AND d.owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<{ id: string; type: string; message_count: number }>();
  if (!row) return httpError.notFound(`alias ${id} not found`);
  if (row.type !== "auto_created") {
    return httpError.validation("only auto_created aliases may be deleted");
  }
  if (row.message_count > 0) {
    return httpError.validation("alias still has associated messages; hide instead");
  }
  await env.DB.prepare(`DELETE FROM aliases WHERE id = ?1`).bind(id).run();
  return Response.json({ object: "alias", id, deleted: true });
}

// ── Thread flags (star/archive/trash/spam/read) ──────────────────────────

interface FlagsBody {
  star?: unknown;
  archive?: unknown;
  trash?: unknown;
  spam?: unknown;
  read?: unknown;
}

function applyFlagDelta(current: number, body: FlagsBody): number {
  let out = current;
  function set(bit: number, on: unknown) {
    if (typeof on !== "boolean") return;
    if (on) out |= bit;
    else out &= ~bit;
  }
  set(FLAG_STARRED, body.star);
  set(FLAG_ARCHIVED, body.archive);
  set(FLAG_TRASH, body.trash);
  set(FLAG_SPAM, body.spam);
  return out;
}

async function applyThreadFlags(
  env: Env,
  user: AuthUser,
  threadId: string,
  body: FlagsBody,
): Promise<boolean> {
  const t = await env.DB
    .prepare(`SELECT flags_bitmap FROM threads WHERE id = ?1 AND owner_id = ?2`)
    .bind(threadId, user.id)
    .first<{ flags_bitmap: number }>();
  if (!t) return false;
  const next = applyFlagDelta(t.flags_bitmap, body);
  if (next !== t.flags_bitmap) {
    await env.DB
      .prepare(`UPDATE threads SET flags_bitmap = ?2 WHERE id = ?1`)
      .bind(threadId, next)
      .run();
  }
  // `read: true` is a shortcut to mark every message in the thread as read.
  if (body.read === true) {
    await env.DB
      .prepare(
        `UPDATE messages SET flags_bitmap = flags_bitmap | 1
         WHERE thread_id = ?1 AND owner_id = ?2 AND (flags_bitmap & 1) = 0`,
      )
      .bind(threadId, user.id)
      .run();
    await env.DB
      .prepare(`UPDATE threads SET unread_count = 0 WHERE id = ?1`)
      .bind(threadId)
      .run();
    // Recompute aliases.unread_count for affected aliases (cheap; bounded by msg count).
    await env.DB
      .prepare(
        `UPDATE aliases
         SET unread_count = (
           SELECT COUNT(*) FROM messages m
           WHERE m.alias_id = aliases.id
             AND m.parse_status != 'duplicate'
             AND m.direction = 'inbound'
             AND (m.flags_bitmap & 1) = 0
         )
         WHERE id IN (
           SELECT DISTINCT alias_id FROM messages
           WHERE thread_id = ?1 AND alias_id IS NOT NULL
         )`,
      )
      .bind(threadId)
      .run();
  }
  return true;
}

async function threadFlags(
  req: Request,
  env: Env,
  user: AuthUser,
  threadId: string,
): Promise<Response> {
  let body: FlagsBody;
  try {
    body = (await req.json()) as FlagsBody;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  const ok = await applyThreadFlags(env, user, threadId, body);
  if (!ok) return httpError.notFound(`thread ${threadId} not found`);
  return Response.json({ object: "thread", id: threadId, updated: true });
}

async function batchFlags(req: Request, env: Env, user: AuthUser): Promise<Response> {
  let body: { ids?: unknown } & FlagsBody;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return httpError.validation("ids must be a non-empty array");
  }
  if (body.ids.length > 500) {
    return httpError.validation("ids cannot exceed 500 per call");
  }
  let updated = 0;
  let missed = 0;
  for (const raw of body.ids) {
    if (typeof raw !== "string") continue;
    const ok = await applyThreadFlags(env, user, raw, body);
    if (ok) updated += 1;
    else missed += 1;
  }
  return Response.json({ object: "list", updated, missed });
}

async function getThreadMessages(env: Env, user: AuthUser, threadId: string): Promise<Response> {
  const t = await env.DB
    .prepare(
      `SELECT t.id, t.subject_normalized, t.message_count, t.unread_count,
              t.participants_json, t.first_message_at, t.last_message_at,
              t.flags_bitmap, t.domain_id,
              (SELECT subject FROM messages
                 WHERE thread_id = t.id AND parse_status != 'duplicate'
                 ORDER BY received_at DESC LIMIT 1) AS subject,
              (SELECT snippet FROM messages
                 WHERE thread_id = t.id AND parse_status != 'duplicate'
                 ORDER BY received_at DESC LIMIT 1) AS snippet
       FROM threads t WHERE t.id = ?1 AND t.owner_id = ?2`,
    )
    .bind(threadId, user.id)
    .first<ThreadRow>();
  if (!t) return httpError.notFound(`thread ${threadId} not found`);

  const msgsRes = await env.DB
    .prepare(
      `SELECT m.id, m.thread_id, m.rfc822_message_id, m.direction, m.from_addr, m.from_name,
              m.to_json, m.cc_json, m.bcc_json, m.reply_to, m.subject, m.snippet,
              m.received_at, m.sent_at, m.size_bytes, m.has_attachments, m.attachment_count,
              m.flags_bitmap, m.parse_status,
              om.id AS outbound_id
       FROM messages m
       LEFT JOIN outbound_messages om ON om.rendered_message_id = m.id
       WHERE m.thread_id = ?1 AND m.parse_status != 'duplicate'
       ORDER BY m.received_at ASC`,
    )
    .bind(threadId)
    .all<MessageRow>();

  const messages = msgsRes.results ?? [];
  const ids = messages.map((m) => m.id);

  let attachments: Map<string, AttachmentRow[]> = new Map();
  if (ids.length) {
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const attRes = await env.DB
      .prepare(
        `SELECT id, message_id, filename, content_type, size_bytes, content_id, is_inline
         FROM attachments WHERE message_id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<AttachmentRow & { message_id: string }>();
    for (const a of attRes.results ?? []) {
      const list = attachments.get(a.message_id) ?? [];
      list.push(a);
      attachments.set(a.message_id, list);
    }
  }

  return Response.json({
    thread: threadShape(t),
    messages: messages.map((m) => messageShape(m, attachments.get(m.id) ?? [])),
  });
}

async function getMessageBody(env: Env, user: AuthUser, messageId: string): Promise<Response> {
  const m = await env.DB
    .prepare(
      `SELECT id, owner_id, r2_key, subject FROM messages WHERE id = ?1`,
    )
    .bind(messageId)
    .first<{ id: string; owner_id: string; r2_key: string | null; subject: string | null }>();
  if (!m || m.owner_id !== user.id) {
    return httpError.notFound(`message ${messageId} not found`);
  }
  if (!m.r2_key) {
    return httpError.notFound(`message has no raw payload`);
  }
  const obj = await env.R2.get(m.r2_key);
  if (!obj) return httpError.notFound(`raw payload missing in R2`);

  const parsed = (await PostalMime.parse(await obj.arrayBuffer())) as {
    text?: string;
    html?: string;
    headers?: Array<{ key: string; value: string }>;
  };

  const headers: Record<string, string> = {};
  for (const h of parsed.headers ?? []) {
    headers[h.key.toLowerCase()] = h.value;
  }

  const sanitizedHtml = parsed.html
    ? await sanitizeEmailHtml(parsed.html, "/api/img-proxy")
    : null;

  return Response.json({
    id: m.id,
    text: parsed.text ?? null,
    html: sanitizedHtml,
    headers,
  });
}

async function markRead(env: Env, user: AuthUser, messageId: string): Promise<Response> {
  // Peek before update so we know whether this transition actually flips
  // bit 0 (avoids double-decrementing alias.unread_count on re-mark-read).
  const before = await env.DB
    .prepare(
      `SELECT thread_id, alias_id, flags_bitmap
       FROM messages WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(messageId, user.id)
    .first<{ thread_id: string | null; alias_id: string | null; flags_bitmap: number }>();
  if (!before) return httpError.notFound(`message ${messageId} not found`);
  const wasUnread = (before.flags_bitmap & 1) === 0;

  await env.DB
    .prepare(`UPDATE messages SET flags_bitmap = flags_bitmap | 1 WHERE id = ?1`)
    .bind(messageId)
    .run();

  if (wasUnread) {
    if (before.thread_id) {
      await env.DB
        .prepare(
          `UPDATE threads SET unread_count =
             (SELECT COUNT(*) FROM messages
              WHERE thread_id = ?1 AND parse_status != 'duplicate' AND (flags_bitmap & 1) = 0)
           WHERE id = ?1`,
        )
        .bind(before.thread_id)
        .run();
    }
    if (before.alias_id) {
      await env.DB
        .prepare(
          `UPDATE aliases SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1`,
        )
        .bind(before.alias_id)
        .run();
    }
  }
  return Response.json({ ok: true });
}

async function getAttachment(env: Env, user: AuthUser, attachmentId: string): Promise<Response> {
  const a = await env.DB
    .prepare(
      `SELECT a.id, a.filename, a.content_type, a.r2_key, m.owner_id
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE a.id = ?1`,
    )
    .bind(attachmentId)
    .first<{ id: string; filename: string | null; content_type: string | null; r2_key: string; owner_id: string }>();
  if (!a || a.owner_id !== user.id) {
    return httpError.notFound(`attachment ${attachmentId} not found`);
  }
  const obj = await env.R2.get(a.r2_key);
  if (!obj) return httpError.notFound(`attachment body missing in R2`);
  return new Response(obj.body, {
    headers: {
      "content-type": a.content_type ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${(a.filename ?? "file").replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    },
  });
}

// ── Outbound + activity (cookie-auth surface for the SPA) ─────────────────
//
// Mirror of /api/v1/emails (bearer) but driven by the session AuthUser. The
// bearer endpoints are still the canonical Resend-compatible API; these are
// duplicates rather than redirects so the SPA gets back exactly the shape it
// wants without going through API-key issuance.

interface OutboundListRow {
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
  request_json: string;
}

// Derive a single display status from the row state — same convention as
// Resend's Emails list. Highest-priority terminal event wins (clicked beats
// opened beats delivered/sent; bounced/complained/failed override).
function deriveDisplayStatus(r: OutboundListRow): string {
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

function shapeOutbound(r: OutboundListRow) {
  const req = JSON.parse(r.request_json) as Record<string, unknown>;
  return {
    id: r.id,
    status: r.status,
    display_status: deriveDisplayStatus(r),
    created_at: new Date(r.created_at).toISOString(),
    sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    scheduled_at: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null,
    bounced_at: r.bounced_at ? new Date(r.bounced_at).toISOString() : null,
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
    tracking: {
      enabled: Boolean(r.tracking_enabled),
      open_count: r.open_count,
      click_count: r.click_count,
      first_opened_at: r.first_opened_at ? new Date(r.first_opened_at).toISOString() : null,
      last_opened_at: r.last_opened_at ? new Date(r.last_opened_at).toISOString() : null,
      first_clicked_at: r.first_clicked_at ? new Date(r.first_clicked_at).toISOString() : null,
      last_clicked_at: r.last_clicked_at ? new Date(r.last_clicked_at).toISOString() : null,
    },
  };
}

// Build the filter clause used by listOutbound / outboundStats /
// outboundTimeseries. Keeps the supported filter dimensions in one place so
// the three endpoints stay consistent.
function buildOutboundFilters(
  url: URL,
  userId: string,
): { sql: string; binds: Array<string | number> } | Response {
  const status = url.searchParams.get("status");
  const display = url.searchParams.get("display"); // delivered|clicked|opened|bounced|...
  const domain = url.searchParams.get("domain");
  const apiKey = url.searchParams.get("api_key");
  const q = url.searchParams.get("q");
  const createdAfter = url.searchParams.get("created_after");
  const createdBefore = url.searchParams.get("created_before");

  const filters: string[] = ["owner_id = ?1"];
  const binds: Array<string | number> = [userId];
  if (status) {
    filters.push(`status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (apiKey) {
    filters.push(`api_key_id = ?${binds.length + 1}`);
    binds.push(apiKey);
  }
  if (domain) {
    filters.push(`json_extract(request_json, '$.from') LIKE ?${binds.length + 1}`);
    binds.push(`%@${domain}%`);
  }
  if (q) {
    filters.push(
      `(json_extract(request_json, '$.subject') LIKE ?${binds.length + 1}
        OR json_extract(request_json, '$.from') LIKE ?${binds.length + 1}
        OR json_extract(request_json, '$.to') LIKE ?${binds.length + 1})`,
    );
    binds.push(`%${q}%`);
  }
  if (createdAfter) {
    const ts = Date.parse(createdAfter);
    if (Number.isNaN(ts)) return httpError.validation("created_after must be ISO8601");
    filters.push(`created_at >= ?${binds.length + 1}`);
    binds.push(ts);
  }
  if (createdBefore) {
    const ts = Date.parse(createdBefore);
    if (Number.isNaN(ts)) return httpError.validation("created_before must be ISO8601");
    filters.push(`created_at < ?${binds.length + 1}`);
    binds.push(ts);
  }
  // `display` is post-filtered in JS since it's derived (not a column).
  if (display) {
    // no-op here; consumer handles it
  }
  return { sql: filters.join(" AND "), binds };
}

async function listOutbound(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100);
  const cursor = url.searchParams.get("cursor");
  const display = url.searchParams.get("display");

  const built = buildOutboundFilters(url, user.id);
  if (built instanceof Response) return built;
  const { sql, binds } = built;
  const filterParts = [sql];
  if (cursor) {
    const [tsRaw, idRaw] = cursor.split(":");
    const ts = parseInt(tsRaw ?? "", 10);
    if (Number.isNaN(ts) || !idRaw) return httpError.validation("invalid cursor");
    filterParts.push(
      `(created_at < ?${binds.length + 1} OR (created_at = ?${binds.length + 1} AND id < ?${binds.length + 2}))`,
    );
    binds.push(ts, idRaw);
  }

  // When `display` is set we filter post-fetch on the derived status. To keep
  // pagination meaningful, page through more rows internally until we either
  // fill the page or run out — capped to keep query cost bounded.
  const fetchLimit = display ? Math.min((limit + 1) * 4, 400) : limit + 1;
  const res = await env.DB
    .prepare(
      `SELECT id, status, created_at, sent_at, scheduled_at, bounced_at,
              bounce_type, bounce_diag, last_error, template_id,
              tracking_enabled, open_count, click_count,
              first_opened_at, last_opened_at, first_clicked_at, last_clicked_at,
              api_key_id, request_json
       FROM outbound_messages
       WHERE ${filterParts.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ${fetchLimit}`,
    )
    .bind(...binds)
    .all<OutboundListRow>();
  let rows = res.results ?? [];
  if (display) {
    rows = rows.filter((r) => deriveDisplayStatus(r) === display);
  }
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const next = hasMore && page.length
    ? `${page[page.length - 1]!.created_at}:${page[page.length - 1]!.id}`
    : null;
  return Response.json({
    object: "list",
    has_more: hasMore,
    next_cursor: next,
    data: page.map(shapeOutbound),
  });
}

interface StatsRow {
  status: string;
  bounce_type: string | null;
  open_count: number;
  click_count: number;
}

async function outboundStats(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const built = buildOutboundFilters(url, user.id);
  if (built instanceof Response) return built;
  const { sql, binds } = built;
  const res = await env.DB
    .prepare(
      `SELECT status, bounce_type, open_count, click_count
       FROM outbound_messages WHERE ${sql}`,
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

async function outboundTimeseries(url: URL, env: Env, user: AuthUser): Promise<Response> {
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
       FROM outbound_messages WHERE ${sql} ORDER BY created_at ASC`,
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

async function listInbound(url: URL, env: Env, user: AuthUser): Promise<Response> {
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

async function getOutbound(env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, status, created_at, sent_at, scheduled_at, bounced_at,
              bounce_type, bounce_diag, last_error, template_id,
              tracking_enabled, open_count, click_count,
              first_opened_at, last_opened_at, first_clicked_at, last_clicked_at,
              api_key_id, request_json
       FROM outbound_messages WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<OutboundListRow>();
  if (!row) return httpError.notFound(`outbound ${id} not found`);
  return Response.json(shapeOutbound(row));
}

async function getOutboundEvents(env: Env, user: AuthUser, id: string): Promise<Response> {
  const owns = await env.DB
    .prepare(`SELECT id FROM outbound_messages WHERE id = ?1 AND owner_id = ?2`)
    .bind(id, user.id)
    .first<{ id: string }>();
  if (!owns) return httpError.notFound(`outbound ${id} not found`);
  const res = await env.DB
    .prepare(
      `SELECT id, type, payload_json, created_at
       FROM events
       WHERE owner_id = ?1 AND (outbound_id = ?2 OR email_id = ?2)
       ORDER BY created_at ASC`,
    )
    .bind(user.id, id)
    .all<{ id: string; type: string; payload_json: string; created_at: number }>();
  return Response.json({
    object: "list",
    email_id: id,
    data: (res.results ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      created_at: new Date(r.created_at).toISOString(),
      data: JSON.parse(r.payload_json),
    })),
  });
}

async function listEvents(url: URL, env: Env, user: AuthUser): Promise<Response> {
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
