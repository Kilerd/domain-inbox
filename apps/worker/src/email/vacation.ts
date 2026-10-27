// Per-owner vacation responder. One reply per sender per three days, never to
// automated mail, own domains, suppressed addresses, or spam-quarantined mail.

import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import { consumeSendQuota } from "../api/quotas";
import { suppressionHits } from "../api/suppressions";
import type { Env } from "../env";
import { domainOf } from "../utils/address";
import { log } from "../utils/log";

export const AUTO_REPLY_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

export interface VacationConfig {
  enabled: boolean;
  subject: string | null;
  body_text: string;
  start_at: number | null;
  end_at: number | null;
}

export async function vacationConfig(
  env: Env,
  ownerId: string,
): Promise<VacationConfig | null> {
  const row = await env.DB
    .prepare(
      `SELECT enabled, subject, body_text, start_at, end_at
       FROM vacation_responders WHERE owner_id = ?1`,
    )
    .bind(ownerId)
    .first<{
      enabled: number;
      subject: string | null;
      body_text: string;
      start_at: number | null;
      end_at: number | null;
    }>();
  if (!row) return null;
  return {
    enabled: Boolean(row.enabled),
    subject: row.subject,
    body_text: row.body_text,
    start_at: row.start_at,
    end_at: row.end_at,
  };
}

/** Pure guard used by maybeAutoReply (exported for tests). */
export function autoReplySuppressed(rawEml: string, from: string, to: string): boolean {
  if (!from || !to) return true;
  if (from.toLowerCase() === to.toLowerCase()) return true;
  if (domainOf(from) === domainOf(to)) return true;
  if (/^(mailer-daemon|postmaster)@/i.test(from)) return true;

  if (/^auto-submitted:/im.test(rawEml)) return true;
  if (/^list-id:/im.test(rawEml)) return true;
  if (/^precedence:\s*(bulk|list|junk)/im.test(rawEml)) return true;
  if (/^x-auto-response-suppress:/im.test(rawEml)) return true;
  // DMARC aggregate and TLS-RPT reports are machine mail, not correspondents.
  if (/^subject:\s*(report domain|report-id|dmarc|tls-?rpt)/im.test(rawEml)) {
    return true;
  }
  return false;
}

export interface AutoReplyOptions {
  ownerId: string;
  from: string;
  to: string;
  subject: string | null;
  rawEml: string;
  inReplyTo?: string | null;
}

/** Send at most one auto-reply; returns whether one was sent. */
export async function maybeAutoReply(
  env: Env,
  opts: AutoReplyOptions,
  now = Date.now(),
): Promise<boolean> {
  if (!env.EMAIL) return false;
  if (autoReplySuppressed(opts.rawEml, opts.from, opts.to)) return false;

  const config = await vacationConfig(env, opts.ownerId);
  if (!config || !config.enabled || !config.body_text.trim()) return false;
  if (config.start_at !== null && now < config.start_at) return false;
  if (config.end_at !== null && now > config.end_at) return false;

  const blocked = await suppressionHits(env, opts.ownerId, [opts.from]);
  if (blocked.length > 0) return false;

  const last = await env.DB
    .prepare(
      `SELECT sent_at FROM auto_reply_log WHERE owner_id = ?1 AND recipient = ?2`,
    )
    .bind(opts.ownerId, opts.from)
    .first<{ sent_at: number }>();
  if (last && now - last.sent_at < AUTO_REPLY_COOLDOWN_MS) return false;

  // Auto-replies share the owner's send budget: a flood of distinct senders
  // must not let the responder bypass the daily cap.
  if (!(await consumeSendQuota(env, opts.ownerId, now))) return false;

  try {
    const mime = createMimeMessage();
    mime.setSender({ addr: opts.to });
    mime.setTo(opts.from);
    mime.setSubject(
      config.subject?.trim() || `Auto: ${opts.subject ?? "(no subject)"}`,
    );
    mime.setHeader("Auto-Submitted", "auto-replied");
    if (opts.inReplyTo) mime.setHeader("In-Reply-To", `<${opts.inReplyTo}>`);
    mime.addMessage({ contentType: "text/plain", data: config.body_text });

    await env.EMAIL.send(
      new EmailMessage(opts.to, opts.from, mime.asRaw()),
    );
    await env.DB
      .prepare(
        `INSERT INTO auto_reply_log (owner_id, recipient, sent_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(owner_id, recipient) DO UPDATE SET sent_at = excluded.sent_at`,
      )
      .bind(opts.ownerId, opts.from, now)
      .run();
    log.info("email.vacation_replied", { to: opts.from, from: opts.to });
    return true;
  } catch (err) {
    log.warn("email.vacation_failed", { to: opts.from, error: String(err) });
    return false;
  }
}
