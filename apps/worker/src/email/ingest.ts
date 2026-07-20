import type { Env } from "../env";
import { newId } from "../ids";
import { log } from "../utils/log";
import { domainOf } from "../utils/address";
import { tryProcessBounce } from "./bounce";
import { parseAndEnrichMessage } from "./parse";
import { assignThread } from "./thread";
import { fanoutEvent } from "../webhooks/dispatch";

interface OwnerLookup {
  domainId: string | null;
  ownerId: string;
  source: "domain" | "dev_fallback";
}

/**
 * Resolve (or lazily create) the alias row matching this recipient. Returns
 * the alias id, or null when we don't have a domain to attach it to (dev
 * fallback path). For catch-all addresses, the row is inserted with
 * `type='auto_created'`.
 */
async function ensureAlias(
  env: Env,
  domainId: string,
  ownerId: string,
  fullAddress: string,
): Promise<{ id: string; disabled: boolean } | null> {
  const lower = fullAddress.toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return null;
  const localPart = lower.slice(0, at);
  const existing = await env.DB
    .prepare(
      `SELECT id, disabled FROM aliases WHERE domain_id = ?1 AND local_part = ?2 LIMIT 1`,
    )
    .bind(domainId, localPart)
    .first<{ id: string; disabled: number }>();
  if (existing) return { id: existing.id, disabled: Boolean(existing.disabled) };

  const id = newId.alias();
  await env.DB
    .prepare(
      `INSERT INTO aliases
         (id, domain_id, local_part, full_address, type, target_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, 'auto_created', ?5, ?6)
       ON CONFLICT(domain_id, local_part) DO NOTHING`,
    )
    .bind(id, domainId, localPart, lower, ownerId, Date.now())
    .run();
  // Re-query to get the actual id (could have lost a race).
  const row = await env.DB
    .prepare(
      `SELECT id, disabled FROM aliases WHERE domain_id = ?1 AND local_part = ?2 LIMIT 1`,
    )
    .bind(domainId, localPart)
    .first<{ id: string; disabled: number }>();
  return row ? { id: row.id, disabled: Boolean(row.disabled) } : null;
}

async function resolveOwner(env: Env, toDomain: string): Promise<OwnerLookup | null> {
  const dom = await env.DB
    .prepare("SELECT id, owner_id FROM domains WHERE domain = ?1 LIMIT 1")
    .bind(toDomain)
    .first<{ id: string; owner_id: string }>();
  if (dom) {
    return { domainId: dom.id, ownerId: dom.owner_id, source: "domain" };
  }

  // Dev fallback: when no domain has been registered yet, route to the dev
  // user so the ingest plumbing is exercisable end-to-end. Removed in prod.
  if (env.DEV_USER_EMAIL) {
    const u = await env.DB
      .prepare("SELECT id FROM users WHERE email = ?1 LIMIT 1")
      .bind(env.DEV_USER_EMAIL.toLowerCase())
      .first<{ id: string }>();
    if (u) return { domainId: null, ownerId: u.id, source: "dev_fallback" };
  }

  return null;
}

function yyyymm(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const now = Date.now();
  const messageId = newId.message();
  const toAddr = message.to.toLowerCase();
  const toDomain = domainOf(toAddr) ?? "";
  const fromAddr = message.from.toLowerCase();

  const owner = await resolveOwner(env, toDomain);
  if (!owner) {
    message.setReject(`no owner configured for ${toDomain}`);
    log.warn("email.rejected", { reason: "no_owner", to: toAddr, from: fromAddr });
    return;
  }

  const alias = owner.domainId
    ? await ensureAlias(env, owner.domainId, owner.ownerId, toAddr)
    : null;
  if (alias?.disabled) {
    message.setReject(`recipient ${toAddr} is disabled`);
    log.info("email.rejected", { reason: "alias_disabled", to: toAddr, from: fromAddr });
    return;
  }
  const aliasId = alias?.id ?? null;

  const r2Key = `raw/${yyyymm(now)}/${messageId}.eml`;
  // Buffer the ReadableStream first. CF Email Routing caps a single email at
  // 25 MiB, which sits well within the Worker's 128 MiB memory budget, and
  // doing so guarantees R2.put gets a body of known length (stream-form R2
  // uploads have been observed to throw when the producer doesn't expose a
  // size hint).
  const rawBuf = await new Response(message.raw).arrayBuffer();
  // Keep a string copy (first 256 KiB) for DSN regex scanning later; the
  // machine-readable delivery-status fields sit near the top of a DSN.
  const rawText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(
    rawBuf.slice(0, Math.min(rawBuf.byteLength, 256 * 1024)),
  );
  await env.R2.put(r2Key, rawBuf, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      msg_id: messageId,
      owner_id: owner.ownerId,
      from: fromAddr,
      to: toAddr,
    },
  });

  await env.DB
    .prepare(
      `INSERT INTO messages
         (id, owner_id, domain_id, alias_id, direction, from_addr, to_json,
          received_at, r2_key, size_bytes, parse_status, created_at)
       VALUES (?1, ?2, ?3, ?4, 'inbound', ?5, ?6, ?7, ?8, ?9, 'raw_only', ?10)`,
    )
    .bind(
      messageId,
      owner.ownerId,
      owner.domainId,
      aliasId,
      fromAddr,
      JSON.stringify([toAddr]),
      now,
      r2Key,
      message.rawSize,
      now,
    )
    .run();

  log.info("email.ingested", {
    msg_id: messageId,
    r2_key: r2Key,
    size: message.rawSize,
    from: fromAddr,
    to: toAddr,
    owner: owner.ownerId,
    owner_source: owner.source,
  });

  // Post-storage processing runs inside a catch-all: the email is already
  // durably stored (R2 object + D1 row), so a parse/thread/bounce failure
  // must not fail the email() handler — that would make the sending MTA
  // retry the whole message and pile up duplicate raw_only rows. The stuck
  // row stays at parse_status='raw_only' for later repair instead.
  try {
    // Synchronous parse + thread for now. The pipeline is structured so it can
    // move to a Queue consumer later without changing the call signatures.
    await parseAndEnrichMessage(env, messageId);
    await assignThread(env, messageId);

    // Bounce / complaint detection. If this inbound is a DSN or ARF report that
    // correlates back to one of our outbound sends, we mutate the outbound's
    // status + write an `email.bounced` / `email.complained` / `email.delivery_delayed`
    // event + add the recipient to suppressions when hard. Suppress the generic
    // `email.received` fanout in that case — the bounce-specific event covers it.
    const bounce = await tryProcessBounce(env, rawText, _ctx);

    if (!bounce) {
      const parsed = await env.DB
        .prepare(`SELECT subject, parse_status FROM messages WHERE id = ?1`)
        .bind(messageId)
        .first<{ subject: string | null; parse_status: string }>();
      if (parsed?.parse_status === "parsed") {
        const eventId = newId.event();
        await env.DB
          .prepare(
            `INSERT INTO events (id, owner_id, type, email_id, payload_json, created_at)
             VALUES (?1, ?2, 'email.received', ?3, ?4, ?5)`,
          )
          .bind(
            eventId,
            owner.ownerId,
            messageId,
            JSON.stringify({
              from: fromAddr,
              to: toAddr,
              subject: parsed.subject,
            }),
            Date.now(),
          )
          .run();
        _ctx.waitUntil(
          fanoutEvent(env, owner.ownerId, "email.received", {
            message_id: messageId,
            from: fromAddr,
            to: toAddr,
            subject: parsed.subject,
          }, eventId),
        );
      }
    }

    // Bump alias counters once we know the message ended up parsed (not a
    // duplicate, not parse-failed). DSN/ARF reports are skipped — a bounce
    // flood shouldn't inflate unread badges.
    if (aliasId && !bounce) {
      const post = await env.DB
        .prepare(`SELECT parse_status FROM messages WHERE id = ?1`)
        .bind(messageId)
        .first<{ parse_status: string }>();
      if (post?.parse_status === "parsed") {
        await env.DB
          .prepare(
            `UPDATE aliases SET
               message_count   = message_count + 1,
               unread_count    = unread_count + 1,
               last_message_at = MAX(COALESCE(last_message_at, 0), ?2)
             WHERE id = ?1`,
          )
          .bind(aliasId, now)
          .run();
      }
    }
  } catch (err) {
    log.warn("email.postprocess_failed", {
      msg_id: messageId,
      from: fromAddr,
      to: toAddr,
      error: String(err),
    });
  }
}
