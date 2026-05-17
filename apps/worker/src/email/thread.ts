import type { Env } from "../env";
import { newId } from "../ids";

export function normalizeSubject(s: string | null | undefined): string {
  if (!s) return "";
  let prev = "";
  let cur = s.replace(/\s+/g, " ").trim();
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/^\s*(re|fwd?|fw|aw|sv|svar|antwort)\s*:\s*/i, "");
  }
  return cur.toLowerCase();
}

interface MessageForThread {
  id: string;
  owner_id: string;
  domain_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  subject: string | null;
  received_at: number | null;
  from_addr: string | null;
  to_json: string | null;
  cc_json: string | null;
  parse_status: string;
}

async function findThreadByMessageId(env: Env, ownerId: string, rfc822Id: string): Promise<string | null> {
  const r = await env.DB
    .prepare(
      `SELECT thread_id FROM messages
       WHERE rfc822_message_id = ?1 AND owner_id = ?2 AND thread_id IS NOT NULL
       LIMIT 1`,
    )
    .bind(rfc822Id, ownerId)
    .first<{ thread_id: string | null }>();
  return r?.thread_id ?? null;
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export async function assignThread(env: Env, messageId: string): Promise<void> {
  const msg = await env.DB
    .prepare(
      `SELECT id, owner_id, domain_id, in_reply_to, references_json, subject,
              received_at, from_addr, to_json, cc_json, parse_status
       FROM messages WHERE id = ?1`,
    )
    .bind(messageId)
    .first<MessageForThread>();
  if (!msg) return;
  if (msg.parse_status === "duplicate") return;

  let threadId: string | null = null;

  if (msg.in_reply_to) {
    threadId = await findThreadByMessageId(env, msg.owner_id, msg.in_reply_to);
  }

  if (!threadId && msg.references_json) {
    const refs = (JSON.parse(msg.references_json) as string[]).slice().reverse();
    for (const ref of refs) {
      const tid = await findThreadByMessageId(env, msg.owner_id, ref);
      if (tid) {
        threadId = tid;
        break;
      }
    }
  }

  const norm = normalizeSubject(msg.subject);

  if (!threadId && norm) {
    const cutoff = (msg.received_at ?? Date.now()) - FOURTEEN_DAYS_MS;
    const r = await env.DB
      .prepare(
        `SELECT id FROM threads
         WHERE owner_id = ?1 AND subject_normalized = ?2 AND last_message_at >= ?3
         ORDER BY last_message_at DESC LIMIT 1`,
      )
      .bind(msg.owner_id, norm, cutoff)
      .first<{ id: string }>();
    if (r) threadId = r.id;
  }

  const now = msg.received_at ?? Date.now();

  if (!threadId) {
    threadId = newId.thread();
    await env.DB
      .prepare(
        `INSERT INTO threads (id, owner_id, domain_id, subject_normalized,
                              participants_json, last_message_at, first_message_at,
                              message_count, unread_count, flags_bitmap)
         VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?5, 0, 0, 0)`,
      )
      .bind(threadId, msg.owner_id, msg.domain_id, norm, now)
      .run();
  }

  await env.DB
    .prepare(`UPDATE messages SET thread_id = ?1 WHERE id = ?2`)
    .bind(threadId, msg.id)
    .run();

  // Merge participants: union of existing thread participants + this message's addrs.
  const partRow = await env.DB
    .prepare(`SELECT participants_json FROM threads WHERE id = ?1`)
    .bind(threadId)
    .first<{ participants_json: string | null }>();
  const existing: string[] = partRow?.participants_json ? JSON.parse(partRow.participants_json) : [];
  const merged = new Set<string>(existing);
  if (msg.from_addr) merged.add(msg.from_addr);
  if (msg.to_json) (JSON.parse(msg.to_json) as string[]).forEach((a) => merged.add(a));
  if (msg.cc_json) (JSON.parse(msg.cc_json) as string[]).forEach((a) => merged.add(a));

  await env.DB
    .prepare(
      `UPDATE threads SET
         participants_json = ?2,
         last_message_at  = MAX(last_message_at, ?3),
         first_message_at = MIN(first_message_at, ?3),
         message_count    = (SELECT COUNT(*) FROM messages WHERE thread_id = ?1 AND parse_status != 'duplicate'),
         unread_count     = (SELECT COUNT(*) FROM messages WHERE thread_id = ?1 AND parse_status != 'duplicate' AND (flags_bitmap & 1) = 0),
         domain_id        = COALESCE(domain_id, ?4)
       WHERE id = ?1`,
    )
    .bind(threadId, JSON.stringify([...merged]), now, msg.domain_id)
    .run();
}
