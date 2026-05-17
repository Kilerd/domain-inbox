// DSN (Delivery Status Notification, RFC 3464) + ARF (RFC 5965) parser.
//
// We get bounce / complaint signals not via a structured provider webhook but
// as real inbound emails that land in the apex catch-all of an owned domain.
// (CF Email Sending refuses subdomain envelopes, so VERP-style routing isn't
// implementable on this provider — see commit 4d547c5.)
//
// Strategy: scan raw .eml with focused regexes for the diagnostic fields,
// extract the *original* Message-ID embedded in the message/rfc822 sub-part,
// and correlate back to outbound_messages by rfc822_message_id.

import type { Env } from "../env";
import { newId } from "../ids";
import { log } from "../utils/log";
import { fanoutEvent } from "../webhooks/dispatch";

export type BounceType = "hard" | "soft" | "complaint" | "unknown";

export interface ParsedDsn {
  kind: "dsn" | "arf" | null;
  bounceType: BounceType;
  /** RFC 5322 Message-ID without surrounding `<>`. */
  originalMessageId: string | null;
  finalRecipient: string | null;
  status: string | null; // e.g. "5.1.1"
  action: string | null; // "failed" | "delayed" | "delivered"
  diagnosticCode: string | null;
}

const RE_DSN = /^content-type:\s*multipart\/report\s*;\s*report-type=delivery-status/im;
const RE_ARF = /^content-type:\s*multipart\/report\s*;\s*report-type=feedback-report/im;
const RE_FINAL_RECIPIENT = /^final-recipient:\s*[^;]+;\s*([^\r\n]+)/im;
const RE_ORIGINAL_RECIPIENT = /^original-recipient:\s*[^;]+;\s*([^\r\n]+)/im;
const RE_STATUS = /^status:\s*(\d\.\d+\.\d+)/im;
const RE_ACTION = /^action:\s*(\w+)/im;
const RE_DIAG = /^diagnostic-code:\s*[^;]*;\s*([^\r\n]+)/im;
const RE_MSGID = /^message-id:\s*<([^>\r\n]+)>/gim;

export function parseDsn(rawEml: string): ParsedDsn {
  const isDsn = RE_DSN.test(rawEml);
  const isArf = RE_ARF.test(rawEml);
  if (!isDsn && !isArf) {
    return {
      kind: null,
      bounceType: "unknown",
      originalMessageId: null,
      finalRecipient: null,
      status: null,
      action: null,
      diagnosticCode: null,
    };
  }

  // The DSN itself has a Message-ID; the *original* message's Message-ID is
  // embedded in the nested message/rfc822 (or text/rfc822-headers) part.
  // Multiple matches in the raw stream — the second one is the original
  // (DSN-wrapped) message id we sent. If only one match exists, use it.
  const msgIds = [...rawEml.matchAll(RE_MSGID)].map((m) => m[1]!);
  const originalMessageId = msgIds.length > 1 ? msgIds[1]! : msgIds[0] ?? null;

  const status = rawEml.match(RE_STATUS)?.[1] ?? null;
  const action = rawEml.match(RE_ACTION)?.[1]?.toLowerCase() ?? null;
  const diag = rawEml.match(RE_DIAG)?.[1]?.trim() ?? null;
  const finalRecipient =
    rawEml.match(RE_FINAL_RECIPIENT)?.[1]?.trim() ??
    rawEml.match(RE_ORIGINAL_RECIPIENT)?.[1]?.trim() ??
    null;

  let bounceType: BounceType = "unknown";
  if (isArf) bounceType = "complaint";
  else if (status?.startsWith("5.")) bounceType = "hard";
  else if (status?.startsWith("4.")) bounceType = "soft";
  else if (action === "failed") bounceType = "hard";
  else if (action === "delayed") bounceType = "soft";

  return {
    kind: isArf ? "arf" : "dsn",
    bounceType,
    originalMessageId,
    finalRecipient: finalRecipient ? finalRecipient.toLowerCase() : null,
    status,
    action,
    diagnosticCode: diag,
  };
}

interface OutboundRow {
  id: string;
  owner_id: string;
  current_status: string;
}

/**
 * Try to process the just-ingested inbound message as a DSN/ARF bounce. Returns
 * the outbound id we matched (so the ingest pipeline can mark this inbound as
 * a duplicate-ish auxiliary record) or null when this isn't a bounce.
 */
export async function tryProcessBounce(
  env: Env,
  rawEml: string,
  ctx: ExecutionContext,
): Promise<{ outbound_id: string; event_type: string } | null> {
  const dsn = parseDsn(rawEml);
  if (!dsn.kind || !dsn.originalMessageId) {
    return null;
  }

  // Correlate to the originating outbound via messages.rfc822_message_id, which
  // is what handleEmailSend writes when persisting the outbound row.
  const outbound = await env.DB
    .prepare(
      `SELECT om.id AS id, om.owner_id AS owner_id, om.status AS current_status
       FROM outbound_messages om
       LEFT JOIN messages m ON m.id = om.rendered_message_id
       WHERE m.rfc822_message_id = ?1
       LIMIT 1`,
    )
    .bind(dsn.originalMessageId)
    .first<OutboundRow>();
  if (!outbound) {
    log.warn("bounce.no_outbound_match", {
      original_message_id: dsn.originalMessageId,
      bounce_type: dsn.bounceType,
      status: dsn.status,
    });
    return null;
  }

  const eventType =
    dsn.kind === "arf"
      ? "email.complained"
      : dsn.bounceType === "hard"
        ? "email.bounced"
        : dsn.bounceType === "soft"
          ? "email.delivery_delayed"
          : "email.failed";

  // Map back to a terminal-or-pending outbound_messages.status. Soft bounces
  // remain "sent" but we still emit the delivery_delayed event for visibility.
  const newStatus =
    dsn.kind === "arf"
      ? "complained"
      : dsn.bounceType === "hard"
        ? "bounced"
        : outbound.current_status; // keep "sent" for soft

  await env.DB
    .prepare(
      `UPDATE outbound_messages
       SET status = ?2, bounced_at = ?3, bounce_type = ?4, bounce_diag = ?5
       WHERE id = ?1`,
    )
    .bind(
      outbound.id,
      newStatus,
      Date.now(),
      dsn.kind === "arf" ? "complaint" : dsn.bounceType,
      dsn.diagnosticCode,
    )
    .run();

  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`,
    )
    .bind(
      newId.event(),
      outbound.owner_id,
      eventType,
      outbound.id,
      JSON.stringify({
        recipient: dsn.finalRecipient,
        status: dsn.status,
        action: dsn.action,
        diagnostic: dsn.diagnosticCode,
        bounce_type: dsn.bounceType,
      }),
      Date.now(),
    )
    .run();

  // Auto-suppress hard bounces and complaints.
  if ((dsn.bounceType === "hard" || dsn.kind === "arf") && dsn.finalRecipient) {
    await env.DB
      .prepare(
        `INSERT INTO suppressions (id, owner_id, email, reason, source_outbound_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(owner_id, email) DO NOTHING`,
      )
      .bind(
        newId.suppression(),
        outbound.owner_id,
        dsn.finalRecipient,
        dsn.kind === "arf" ? "complaint" : "hard_bounce",
        outbound.id,
        Date.now(),
      )
      .run();
  }

  ctx.waitUntil(
    fanoutEvent(env, outbound.owner_id, eventType, {
      email_id: outbound.id,
      recipient: dsn.finalRecipient,
      bounce: {
        type: dsn.bounceType,
        status: dsn.status,
        diagnostic: dsn.diagnosticCode,
      },
    }),
  );

  log.info("bounce.processed", {
    outbound_id: outbound.id,
    event_type: eventType,
    bounce_type: dsn.bounceType,
    status: dsn.status,
    recipient: dsn.finalRecipient,
  });

  return { outbound_id: outbound.id, event_type: eventType };
}
