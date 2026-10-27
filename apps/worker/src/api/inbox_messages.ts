import PostalMime from "postal-mime";
import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { recountThread } from "../email/counters";
import { httpError } from "../http";
import { FLAG_READ } from "../utils/flags";
import { sanitizeEmailHtml } from "./sanitize";

export async function getMessageBody(env: Env, user: AuthUser, messageId: string): Promise<Response> {
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

export async function markRead(env: Env, user: AuthUser, messageId: string): Promise<Response> {
  // Recompute (rather than decrement) so a re-mark-read and a thread whose
  // other messages changed can never leave the badge off by one.
  const before = await env.DB
    .prepare(
      `SELECT thread_id, flags_bitmap
       FROM messages WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(messageId, user.id)
    .first<{ thread_id: string | null; flags_bitmap: number }>();
  if (!before) return httpError.notFound(`message ${messageId} not found`);
  if ((before.flags_bitmap & FLAG_READ) !== 0) return Response.json({ ok: true });

  await env.DB
    .prepare(
      `UPDATE messages SET flags_bitmap = flags_bitmap | ${FLAG_READ} WHERE id = ?1`,
    )
    .bind(messageId)
    .run();

  if (before.thread_id) await recountThread(env, before.thread_id);
  return Response.json({ ok: true });
}

export async function getAttachment(env: Env, user: AuthUser, attachmentId: string): Promise<Response> {
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

