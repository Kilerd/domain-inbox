export interface ThreadRow {
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

export interface MessageRow {
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

export interface AttachmentRow {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  content_id: string | null;
  is_inline: number;
}

/**
 * SQL fragment for "this thread has received mail". The Inbox is a received
 * mailbox: a thread that only ever went out (verification sends, forwards)
 * belongs in Sent/All, not here. Expects the threads table to be aliased `t`.
 */
export const HAS_INBOUND_SQL =
  "EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' AND m.parse_status != 'duplicate')";

export function jsonArr(s: string | null): string[] {
  if (!s) return [];
  try {
    return JSON.parse(s) as string[];
  } catch {
    return [];
  }
}

export function threadShape(t: ThreadRow) {
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

export function messageShape(m: MessageRow, attachments: AttachmentRow[] = []) {
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
