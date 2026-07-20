import PostalMime from "postal-mime";
import type { Env } from "../env";
import { newId } from "../ids";
import { log } from "../utils/log";

interface ParsedAddress {
  address?: string;
  name?: string;
}

interface ParsedAttachment {
  filename?: string;
  mimeType?: string;
  disposition?: string;
  contentId?: string;
  content: ArrayBuffer | Uint8Array;
}

interface ParsedEmail {
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];
  from?: ParsedAddress;
  to?: ParsedAddress[];
  cc?: ParsedAddress[];
  bcc?: ParsedAddress[];
  replyTo?: ParsedAddress[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: ParsedAttachment[];
}

function lowerAddrs(arr: ParsedAddress[] | undefined): string[] {
  return (arr ?? [])
    .map((a) => (a.address ? a.address.toLowerCase() : null))
    .filter((s): s is string => Boolean(s));
}

export function refsToArrayJson(refs: string | string[] | undefined): string | null {
  if (!refs) return null;
  // Store bare message-ids (no angle brackets) — rfc822_message_id is stored
  // bare too, and thread lookup compares the two with `=`.
  const list = (Array.isArray(refs) ? refs : refs.split(/\s+/))
    .map((s) => s.trim().replace(/^<|>$/g, ""))
    .filter(Boolean);
  return list.length ? JSON.stringify(list) : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toUint8(content: ArrayBuffer | Uint8Array): Uint8Array {
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

async function markFailed(env: Env, messageId: string, error: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE messages SET parse_status = 'failed', parse_error = ?2 WHERE id = ?1`)
    .bind(messageId, error.slice(0, 1000))
    .run();
}

/**
 * Parse the raw MIME at messages.r2_key, then enrich the row with extracted
 * fields and insert attachment rows (deduped by sha256 in R2).
 *
 * Re-entrant: subsequent calls with the same messageId are safe (parse_status
 * gates re-work, attachments use INSERT OR IGNORE on a composite unique).
 */
export async function parseAndEnrichMessage(env: Env, messageId: string): Promise<void> {
  const row = await env.DB
    .prepare("SELECT r2_key, parse_status, owner_id FROM messages WHERE id = ?1")
    .bind(messageId)
    .first<{ r2_key: string | null; parse_status: string; owner_id: string }>();
  if (!row || !row.r2_key) {
    return;
  }
  if (row.parse_status === "parsed" || row.parse_status === "duplicate") {
    return;
  }

  const obj = await env.R2.get(row.r2_key);
  if (!obj) {
    await markFailed(env, messageId, `raw not in R2: ${row.r2_key}`);
    return;
  }

  let parsed: ParsedEmail;
  try {
    const buf = await obj.arrayBuffer();
    parsed = (await PostalMime.parse(buf)) as ParsedEmail;
  } catch (err) {
    await markFailed(env, messageId, `postal-mime: ${err}`);
    return;
  }

  const fromAddr = parsed.from?.address?.toLowerCase() ?? null;
  const fromName = parsed.from?.name ?? null;
  const toList = lowerAddrs(parsed.to);
  const ccList = lowerAddrs(parsed.cc);
  const bccList = lowerAddrs(parsed.bcc);
  const replyTo = parsed.replyTo?.[0]?.address?.toLowerCase() ?? null;
  const subject = parsed.subject ?? null;
  const msgIdRaw = parsed.messageId ?? null;
  const msgId = msgIdRaw ? msgIdRaw.replace(/^<|>$/g, "") : null;
  const inReplyToRaw = parsed.inReplyTo ?? null;
  const inReplyTo = inReplyToRaw ? inReplyToRaw.replace(/^<|>$/g, "") : null;
  const refsJson = refsToArrayJson(parsed.references);

  const textBody = parsed.text ?? (parsed.html ? stripHtml(parsed.html) : "");
  const snippet = textBody.trim().slice(0, 200) || null;

  const attachments = parsed.attachments ?? [];

  // Dedup on rfc822_message_id *within this owner*: the same RFC822 message
  // legitimately arrives once per recipient tenant (one To: a@owner1.com,
  // b@owner2.com delivery fans out to two owners) — only same-owner copies
  // are duplicates. Keep the row for audit; r2 raw is fine to garbage-collect later.
  if (msgId) {
    const dup = await env.DB
      .prepare(
        "SELECT id FROM messages WHERE owner_id = ?3 AND rfc822_message_id = ?1 AND id != ?2 LIMIT 1",
      )
      .bind(msgId, messageId, row.owner_id)
      .first<{ id: string }>();
    if (dup) {
      await env.DB
        .prepare(`UPDATE messages SET parse_status = 'duplicate', parse_error = ?2 WHERE id = ?1`)
        .bind(messageId, `duplicate of ${dup.id}`)
        .run();
      return;
    }
  }

  try {
    await env.DB
      .prepare(
        `UPDATE messages SET
         rfc822_message_id = ?2,
         in_reply_to       = ?3,
         references_json   = ?4,
         from_addr         = COALESCE(?5, from_addr),
         from_name         = ?6,
         to_json           = ?7,
         cc_json           = ?8,
         bcc_json          = ?9,
         reply_to          = ?10,
         subject           = ?11,
         snippet           = ?12,
         has_attachments   = ?13,
         attachment_count  = ?14
       WHERE id = ?1`,
      )
      .bind(
        messageId,
        msgId,
        inReplyTo,
        refsJson,
        fromAddr,
        fromName,
        JSON.stringify(toList),
        ccList.length ? JSON.stringify(ccList) : null,
        bccList.length ? JSON.stringify(bccList) : null,
        replyTo,
        subject,
        snippet,
        attachments.length ? 1 : 0,
        attachments.length,
      )
      .run();
  } catch (err) {
    // Concurrent ingest of the same Message-ID for the same owner: the loser
    // of the UNIQUE(owner_id, rfc822_message_id) race is a duplicate, not a
    // pipeline failure (an uncaught throw here would make the sending MTA
    // retry the whole email).
    if (/UNIQUE constraint failed/i.test(String(err))) {
      await env.DB
        .prepare(`UPDATE messages SET parse_status = 'duplicate', parse_error = ?2 WHERE id = ?1`)
        .bind(messageId, `duplicate (lost dedup race): ${msgId}`)
        .run();
      return;
    }
    throw err;
  }

  for (const att of attachments) {
    const bytes = toUint8(att.content);
    const sha = await sha256Hex(bytes);
    const attKey = `att/${sha.slice(0, 2)}/${sha}`;
    const head = await env.R2.head(attKey);
    if (!head) {
      await env.R2.put(attKey, bytes, {
        httpMetadata: { contentType: att.mimeType ?? "application/octet-stream" },
        customMetadata: {
          sha256: sha,
          filename: att.filename ?? "",
        },
      });
    }
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO attachments (id, message_id, filename, content_type, size_bytes, content_id, is_inline, r2_key, sha256)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        newId.attachment(),
        messageId,
        att.filename ?? null,
        att.mimeType ?? null,
        bytes.byteLength,
        att.contentId ?? null,
        att.disposition === "inline" ? 1 : 0,
        attKey,
        sha,
      )
      .run();
  }

  // Flip to 'parsed' only after attachment rows exist: a crash mid-loop
  // leaves the row re-processable (the attachment INSERTs are idempotent via
  // UNIQUE(message_id, sha256) + OR IGNORE) instead of permanently recording
  // attachment_count > 0 with missing rows.
  await env.DB
    .prepare(`UPDATE messages SET parse_status = 'parsed' WHERE id = ?1`)
    .bind(messageId)
    .run();

  log.info("email.parsed", {
    msg_id: messageId,
    rfc822_id: msgId,
    from: fromAddr,
    subject: subject?.slice(0, 80),
    attachments: attachments.length,
  });
}
