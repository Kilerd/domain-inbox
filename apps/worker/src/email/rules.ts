// Evaluate the owner's inbound rules after a message has been parsed and
// threaded. Rules are AND-matched on the fields they specify; all matching
// rules contribute their flag actions (OR-ed together).

import type { RuleActions, RuleMatch } from "../api/rules";
import type { Env } from "../env";
import {
  FLAG_ARCHIVED,
  FLAG_READ,
  FLAG_SPAM,
  FLAG_STARRED,
  FLAG_TRASH,
} from "../utils/flags";
import { log } from "../utils/log";
import { recountThread } from "./counters";

interface RuleRow {
  id: string;
  match_json: string;
  actions_json: string;
}

interface MessageRow {
  id: string;
  thread_id: string | null;
  from_addr: string | null;
  to_json: string | null;
  subject: string | null;
  has_attachments: number;
}

/**
 * Conservative automatic quarantine: only when SPF, DKIM *and* DMARC all
 * failed on the same message. Cloudflare's inbound Authentication-Results
 * header is the source; if it is absent we do not guess.
 */
export function authFailureSpam(rawEml: string): boolean {
  const headers = rawEml.match(/^authentication-results:.*$/gim) ?? [];
  if (headers.length === 0) return false;
  const text = headers.join(" ").toLowerCase();
  return /dmarc=fail/.test(text) && /spf=fail/.test(text) && /dkim=fail/.test(text);
}

function matches(match: RuleMatch, msg: MessageRow): boolean {
  const from = (msg.from_addr ?? "").toLowerCase();
  const subject = (msg.subject ?? "").toLowerCase();
  let to: string[] = [];
  try {
    to = (JSON.parse(msg.to_json ?? "[]") as string[]).map((a) => a.toLowerCase());
  } catch {
    to = [];
  }

  if (match.from && !from.includes(match.from.toLowerCase())) return false;
  if (match.to && !to.some((a) => a.includes(match.to!.toLowerCase()))) return false;
  if (match.subject && !subject.includes(match.subject.toLowerCase())) return false;
  if (
    match.hasAttachment !== undefined &&
    Boolean(msg.has_attachments) !== match.hasAttachment
  ) {
    return false;
  }
  return true;
}

/**
 * Apply matching rules to the message/thread. Returns whether the thread is
 * now quarantined as spam (used to suppress the vacation responder).
 */
export async function applyInboundRules(
  env: Env,
  ownerId: string,
  messageId: string,
  automaticSpam = false,
): Promise<boolean> {
  const msg = await env.DB
    .prepare(
      `SELECT id, thread_id, from_addr, to_json, subject, has_attachments
       FROM messages WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(messageId, ownerId)
    .first<MessageRow>();
  if (!msg || !msg.thread_id) return automaticSpam;

  const rules = await env.DB
    .prepare(
      `SELECT id, match_json, actions_json FROM email_rules
       WHERE owner_id = ?1 AND enabled = 1
       ORDER BY priority, created_at`,
    )
    .bind(ownerId)
    .all<RuleRow>();

  let bits = automaticSpam ? FLAG_SPAM : 0;
  let read = false;
  let matched = 0;

  for (const rule of rules.results ?? []) {
    let match: RuleMatch;
    let actions: RuleActions;
    try {
      match = JSON.parse(rule.match_json) as RuleMatch;
      actions = JSON.parse(rule.actions_json) as RuleActions;
    } catch {
      continue;
    }
    if (!matches(match, msg)) continue;
    matched += 1;
    if (actions.star) bits |= FLAG_STARRED;
    if (actions.archive) bits |= FLAG_ARCHIVED;
    if (actions.trash) bits |= FLAG_TRASH;
    if (actions.spam) bits |= FLAG_SPAM;
    if (actions.read) read = true;
  }

  if (bits) {
    await env.DB
      .prepare(
        `UPDATE threads SET flags_bitmap = flags_bitmap | ?2
         WHERE id = ?1 AND owner_id = ?3`,
      )
      .bind(msg.thread_id, bits, ownerId)
      .run();
  }
  if (read) {
    await env.DB
      .prepare(
        `UPDATE messages SET flags_bitmap = flags_bitmap | ${FLAG_READ} WHERE id = ?1`,
      )
      .bind(messageId)
      .run();
    await recountThread(env, msg.thread_id);
  }

  if (bits || read) {
    log.info("email.rules_applied", {
      message_id: messageId,
      thread_id: msg.thread_id,
      matched,
      bits,
      read,
      automatic_spam: automaticSpam,
    });
  }
  return (bits & FLAG_SPAM) !== 0;
}
