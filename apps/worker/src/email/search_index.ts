// Maintain the FTS5 search index. New messages are indexed from the copy in
// R2; a cron backfill walks older parsed messages in small batches so a
// deploy does not have to parse the entire mailbox in one request.

import PostalMime from "postal-mime";
import type { Env } from "../env";
import { log } from "../utils/log";
import { stripHtml } from "./parse";

const MAX_BODY_CHARS = 64 * 1024;
const BACKFILL_BATCH = 20;

interface IndexRow {
  owner_id: string;
  thread_id: string | null;
  r2_key: string | null;
  subject: string | null;
  from_addr: string | null;
  to_json: string | null;
  parse_status: string;
}

function jsonAddrs(raw: string | null): string[] {
  try {
    const arr = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(arr)
      ? arr.filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase())
      : [];
  } catch {
    return [];
  }
}

/** Insert or replace one message's search row. Safe to call twice. */
export async function indexMessageForSearch(
  env: Env,
  messageId: string,
): Promise<void> {
  const row = await env.DB
    .prepare(
      `SELECT owner_id, thread_id, r2_key, subject, from_addr, to_json, parse_status
       FROM messages WHERE id = ?1`,
    )
    .bind(messageId)
    .first<IndexRow>();
  if (!row || !row.thread_id || row.parse_status !== "parsed") return;

  let subject = row.subject ?? "";
  let from = (row.from_addr ?? "").toLowerCase();
  let toText = jsonAddrs(row.to_json).join(" ");
  let body = "";

  if (row.r2_key) {
    const obj = await env.R2.get(row.r2_key);
    if (obj) {
      try {
        const parsed = await PostalMime.parse(await obj.arrayBuffer());
        if (parsed.subject) subject = parsed.subject;
        if (parsed.from?.address) from = parsed.from.address.toLowerCase();
        const to = (parsed.to ?? [])
          .map((a) => a.address?.toLowerCase())
          .filter((a): a is string => Boolean(a));
        if (to.length > 0) toText = to.join(" ");
        body =
          parsed.text ??
          (parsed.html ? stripHtml(parsed.html) : "");
      } catch (err) {
        log.warn("search.parse_failed", { message_id: messageId, error: String(err) });
      }
    }
  }

  body = body.slice(0, MAX_BODY_CHARS);
  await env.DB
    .prepare(`DELETE FROM message_fts WHERE message_id = ?1`)
    .bind(messageId)
    .run();
  await env.DB
    .prepare(
      `INSERT INTO message_fts
         (message_id, owner_id, thread_id, subject, body, from_addr, to_text)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(messageId, row.owner_id, row.thread_id, subject, body, from, toText)
    .run();
}

/** Index up to `limit` parsed messages that have no FTS row yet. */
export async function backfillSearchIndex(
  env: Env,
  limit = BACKFILL_BATCH,
): Promise<number> {
  const res = await env.DB
    .prepare(
      `SELECT m.id FROM messages m
       LEFT JOIN message_fts f ON f.message_id = m.id
       WHERE f.message_id IS NULL
         AND m.parse_status = 'parsed'
         AND m.thread_id IS NOT NULL
       ORDER BY m.created_at DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string }>();

  let indexed = 0;
  for (const row of res.results ?? []) {
    try {
      await indexMessageForSearch(env, row.id);
      indexed += 1;
    } catch (err) {
      log.warn("search.backfill_failed", { message_id: row.id, error: String(err) });
    }
  }
  if (indexed > 0) log.info("search.backfilled", { count: indexed });
  return indexed;
}
