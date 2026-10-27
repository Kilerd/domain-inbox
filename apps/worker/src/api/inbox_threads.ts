import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { recountThread } from "../email/counters";
import { httpError } from "../http";
import { FLAG_ARCHIVED, FLAG_READ, FLAG_SPAM, FLAG_STARRED, FLAG_TRASH } from "../utils/flags";
import {
  HAS_INBOUND_SQL,
  messageShape,
  threadShape,
  type AttachmentRow,
  type MessageRow,
  type ThreadRow,
} from "./inbox_shared";

type View = "inbox" | "unread" | "starred" | "archived" | "trash" | "spam" | "sent" | "all";

interface ViewFilter {
  where: string;
  binds: unknown[];
}

function viewClause(view: View): ViewFilter {
  // inbox = received mail that is not archived/trash/spam. A thread enters
  // the inbox when something arrives; pure outbound threads live in Sent/All.
  switch (view) {
    case "unread":
      return {
        where: `t.unread_count > 0 AND (t.flags_bitmap & ?) = 0 AND ${HAS_INBOUND_SQL}`,
        binds: [FLAG_TRASH | FLAG_SPAM],
      };
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
          "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.direction = 'outbound' AND m.parse_status != 'duplicate')",
        binds: [],
      };
    case "all":
      return { where: "1=1", binds: [] };
    case "inbox":
    default:
      return {
        where: `(t.flags_bitmap & ?) = 0 AND ${HAS_INBOUND_SQL}`,
        binds: [FLAG_ARCHIVED | FLAG_TRASH | FLAG_SPAM],
      };
  }
}

export async function listThreads(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
  const cursorParam = url.searchParams.get("cursor");
  const view = (url.searchParams.get("view") ?? "inbox") as View;
  const domain = url.searchParams.get("domain");
  const alias = url.searchParams.get("alias");
  const q = url.searchParams.get("q")?.trim() ?? "";

  const filter = viewClause(view);
  const where: string[] = ["t.owner_id = ?", filter.where];
  const binds: unknown[] = [user.id, ...filter.binds];

  if (cursorParam) {
    // cursor = "<last_message_at>:<id>" — the id tiebreaker prevents rows
    // sharing the boundary timestamp from being skipped across pages.
    // A bare timestamp (legacy client) still works, minus tie protection.
    const [tsRaw, idRaw] = cursorParam.split(":");
    const ts = parseInt(tsRaw ?? "", 10);
    if (Number.isNaN(ts)) return httpError.validation("invalid cursor");
    if (idRaw) {
      where.push("(t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))");
      binds.push(ts, ts, idRaw);
    } else {
      where.push("t.last_message_at < ?");
      binds.push(ts);
    }
  }

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
    // Escape LIKE metacharacters instead of stripping them — searching for
    // "100%" should search for "100%", not "100".
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND " +
        "(m.subject LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\' OR m.from_addr LIKE ? ESCAPE '\\'))",
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
    ORDER BY t.last_message_at DESC, t.id DESC
    LIMIT ?`;

  const res = await env.DB.prepare(sql).bind(...binds).all<ThreadRow>();
  const rows = res.results ?? [];
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1]!;
    nextCursor = `${last.last_message_at}:${last.id}`;
    rows.length = limit;
  }

  return Response.json({
    threads: rows.map(threadShape),
    next_cursor: nextCursor,
  });
}

// ── Navigator stats ───────────────────────────────────────────────────────

// ── Thread flags (star/archive/trash/spam/read) ──────────────────────────

interface FlagsBody {
  star?: unknown;
  archive?: unknown;
  trash?: unknown;
  spam?: unknown;
  read?: unknown;
}

// One bit-mask update per chunk instead of a query loop per thread. D1 caps
// a statement at 100 bound parameters, so chunks leave room for owner/ids.
const FLAG_BATCH_SIZE = 90;

function flagMasks(body: FlagsBody): { set: number; keep: number } {
  let setBits = 0;
  let clearBits = 0;
  const put = (bit: number, on: unknown) => {
    if (typeof on !== "boolean") return;
    if (on) setBits |= bit;
    else clearBits |= bit;
  };
  put(FLAG_STARRED, body.star);
  put(FLAG_ARCHIVED, body.archive);
  put(FLAG_TRASH, body.trash);
  put(FLAG_SPAM, body.spam);
  return { set: setBits, keep: (~clearBits) >>> 0 };
}

interface ThreadFlagResult {
  updated: number;
  missed: number;
}

async function applyThreadFlagsBatch(
  env: Env,
  user: AuthUser,
  ids: string[],
  body: FlagsBody,
): Promise<ThreadFlagResult> {
  const found = new Set<string>();
  const { set, keep } = flagMasks(body);
  const changeBits = set !== 0 || keep !== 0xffffffff;

  for (let i = 0; i < ids.length; i += FLAG_BATCH_SIZE) {
    const chunk = ids.slice(i, i + FLAG_BATCH_SIZE);
    const ownerFirst = chunk.map((_, j) => `?${j + 2}`).join(",");

    const chunkFound: string[] = [];
    if (changeBits) {
      // ?1 set, ?2 keep, ?3 owner, ?4.. ids
      const idPh = chunk.map((_, j) => `?${j + 4}`).join(",");
      const res = await env.DB
        .prepare(
          `UPDATE threads SET flags_bitmap = (flags_bitmap | ?1) & ?2
           WHERE owner_id = ?3 AND id IN (${idPh})
           RETURNING id`,
        )
        .bind(set, keep, user.id, ...chunk)
        .all<{ id: string }>();
      for (const row of res.results ?? []) chunkFound.push(row.id);
    } else {
      const res = await env.DB
        .prepare(
          `SELECT id FROM threads WHERE owner_id = ?1 AND id IN (${ownerFirst})`,
        )
        .bind(user.id, ...chunk)
        .all<{ id: string }>();
      for (const row of res.results ?? []) chunkFound.push(row.id);
    }
    for (const id of chunkFound) found.add(id);

    if (body.read === true && chunkFound.length > 0) {
      await env.DB
        .prepare(
          `UPDATE messages SET flags_bitmap = flags_bitmap | ${FLAG_READ}
           WHERE owner_id = ?1 AND thread_id IN (${ownerFirst})
             AND (flags_bitmap & ${FLAG_READ}) = 0`,
        )
        .bind(user.id, ...chunk)
        .run();
      await env.DB
        .prepare(
          `UPDATE threads SET unread_count = (
             SELECT COUNT(*) FROM messages m
             WHERE m.thread_id = threads.id
               AND m.parse_status != 'duplicate'
               AND (m.flags_bitmap & ${FLAG_READ}) = 0
           )
           WHERE owner_id = ?1 AND id IN (${ownerFirst})`,
        )
        .bind(user.id, ...chunk)
        .run();
    }
  }

  const updated = ids.filter((id) => found.has(id)).length;
  return { updated, missed: ids.length - updated };
}

export async function threadFlags(
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
  const { updated } = await applyThreadFlagsBatch(env, user, [threadId], body);
  if (updated === 0) return httpError.notFound(`thread ${threadId} not found`);
  return Response.json({ object: "thread", id: threadId, updated: true });
}

export async function batchFlags(req: Request, env: Env, user: AuthUser): Promise<Response> {
  let body: { ids?: unknown } & FlagsBody;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return httpError.validation("ids must be a non-empty array");
  }
  if (body.ids.length > 100) {
    return httpError.validation("ids cannot exceed 100 per call");
  }
  const ids = body.ids.filter((raw): raw is string => typeof raw === "string");
  const { updated, missed } = await applyThreadFlagsBatch(env, user, ids, body);
  return Response.json({ object: "list", updated, missed });
}

export async function getThreadMessages(env: Env, user: AuthUser, threadId: string): Promise<Response> {
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

  // Chunk the IN() lookups: D1 caps bound parameters at 100 per statement,
  // and a long thread can exceed that.
  const attachments: Map<string, AttachmentRow[]> = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
    const attRes = await env.DB
      .prepare(
        `SELECT id, message_id, filename, content_type, size_bytes, content_id, is_inline
         FROM attachments WHERE message_id IN (${placeholders})`,
      )
      .bind(...chunk)
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

