import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import type { ApiKeyAuth } from "./apikey_auth";
import {
  cacheIdempotentSend,
  checkIdempotencyKey,
  requestFingerprint,
  resolveReservationConflict,
  type IdempotentReply,
  type IdempotentSend,
} from "./idempotency";
import {
  getOutboundRow,
  listOutboundEvents,
  listOutboundRows,
  shapeOutbound,
} from "./outbound";
import { suppressionHits } from "./suppressions";
import { getTemplateById, renderTemplate } from "./templates";
import { rewriteHtmlForTracking } from "./tracking";
import { assignThread } from "../email/thread";
import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";
import {
  asAddrList,
  domainOf,
  firstInvalid,
  parseAddr,
  type Addr,
} from "../utils/address";
import { log } from "../utils/log";
import { fanoutEvent } from "../webhooks/dispatch";

interface Attachment {
  filename: string;
  content?: string; // base64-encoded
  path?: string;
  content_type?: string;
  content_id?: string;
}

interface SendEmailBody {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  reply_to?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  headers?: unknown;
  attachments?: unknown;
  tags?: unknown;
  scheduled_at?: unknown;
  // Template extension (not part of Resend's API but a strict superset):
  // `template` is the tpl_ id; `template_data` is the variable map. When
  // provided, the rendered subject/html/text override body.subject etc.
  template?: unknown;
  template_data?: unknown;
  // Resend-compatible per-send tracking override. When absent, falls back
  // to the from-domain's defaults (domains.open_tracking / click_tracking).
  tracking?: unknown;
}

interface DomainRow {
  id: string;
  verification_status: string;
  open_tracking: number;
  click_tracking: number;
}

export async function handleEmailSend(
  req: Request,
  env: Env,
  key: ApiKeyAuth,
  ctx?: ExecutionContext,
  /**
   * API-key callers get Resend's async semantics: answer with the id once the
   * row is reserved, and finish the provider call in the background. The
   * browser compose path passes `false` because its drawer immediately
   * refetches the inbox and expects the sent message to already be there.
   */
  background = true,
): Promise<Response> {
  if (!key.scopes.includes("emails.send")) {
    return httpError.forbidden("API key lacks emails.send scope");
  }
  if (!env.EMAIL) {
    return httpError.internal(
      "send_email binding not configured (Workers Paid plan + verified domain required)",
      503,
    );
  }

  const idempotencyKey = req.headers.get("Idempotency-Key");

  let body: SendEmailBody;
  try {
    body = (await req.json()) as SendEmailBody;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  // Fingerprint the payload exactly as the client sent it, before template
  // rendering mutates `body`, so a replay compares like with like.
  const requestHash = idempotencyKey ? await requestFingerprint(body) : null;

  if (typeof body.from !== "string" || !body.from.trim()) {
    return httpError.validation("`from` is required");
  }
  if (body.to == null) {
    return httpError.validation("`to` is required");
  }

  // Template resolution: when `template` is supplied we render its
  // subject/html/text and treat them as the request's content. Caller-provided
  // subject/html/text still win — useful for per-send overrides on top of the
  // base template.
  let templateId: string | null = null;
  if (typeof body.template === "string" && body.template.trim()) {
    const tplRow = await getTemplateById(env, key.user_id, body.template.trim());
    if (!tplRow) {
      return httpError.validation(`template ${body.template} not found`);
    }
    const vars =
      body.template_data && typeof body.template_data === "object"
        ? (body.template_data as Record<string, unknown>)
        : {};
    const rendered = renderTemplate(tplRow, vars);
    templateId = tplRow.id;
    if (typeof body.subject !== "string" && rendered.subject != null) {
      body.subject = rendered.subject;
    }
    if (typeof body.html !== "string" && rendered.html != null) {
      body.html = rendered.html;
    }
    if (typeof body.text !== "string" && rendered.text != null) {
      body.text = rendered.text;
    }
  }

  if (typeof body.subject !== "string") {
    return httpError.validation("`subject` is required");
  }
  if (!body.html && !body.text) {
    return httpError.validation("one of `html` or `text` is required");
  }

  const prep = await prepareSendContext(env, key.user_id, body);
  if (prep.kind === "error") return prep.response;
  const { from, to, cc, bcc, fromDomain, dom, tracking } = prep;

  if (
    key.domain_scope &&
    !key.domain_scope.includes(dom.id) &&
    !key.domain_scope.includes(fromDomain)
  ) {
    return httpError.forbidden(`API key not scoped to send from ${fromDomain}`);
  }

  const now = Date.now();

  // Idempotency (Resend semantics, see ./idempotency): within 24 h of the
  // original request a replay returns the prior id (in-flight included) or
  // 409 if the payload differs; a failed attempt or an expired key is
  // released so the request below reserves a fresh row and actually sends.
  let idempotency: IdempotentSend | null = null;
  if (idempotencyKey && requestHash) {
    const outcome = await checkIdempotencyKey(env, key.user_id, idempotencyKey, requestHash, now);
    if (outcome.kind !== "proceed") return idempotencyResponse(outcome);
    idempotency = { key: idempotencyKey, hash: requestHash, createdAt: now };
  }

  const outboundId = newId.outbound();
  const trackingFlag = tracking.opens || tracking.clicks ? 1 : 0;

  // Scheduling: a future scheduled_at defers the actual send to the cron
  // sweep (processScheduledSends); the row is created in status 'scheduled'.
  let scheduledAt: number | null = null;
  if (typeof body.scheduled_at === "string" && body.scheduled_at.trim()) {
    const ts = Date.parse(body.scheduled_at);
    if (Number.isNaN(ts)) {
      return httpError.validation("scheduled_at could not be parsed");
    }
    if (ts > now + 30_000) scheduledAt = ts;
  }

  // Pre-record so failures are observable. UNIQUE(owner_id, idempotency_key)
  // doubles as the atomic idempotency reservation: a concurrent duplicate
  // loses the insert race and is answered from the winner's row.
  try {
    await env.DB
      .prepare(
        `INSERT INTO outbound_messages
           (id, owner_id, api_key_id, idempotency_key, idempotency_hash, status,
            request_json, attempts, template_id, tracking_enabled, scheduled_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?11, ?9, ?5, 0, ?6, ?7, ?10, ?8)`,
      )
      .bind(
        outboundId,
        key.user_id,
        key.key_id,
        idempotency?.key ?? null,
        JSON.stringify(body),
        templateId,
        trackingFlag,
        now,
        scheduledAt ? "scheduled" : "sending",
        scheduledAt,
        idempotency?.hash ?? null,
      )
      .run();
  } catch (err) {
    if (idempotency && /UNIQUE constraint failed/i.test(String(err))) {
      const outcome = await resolveReservationConflict(
        env,
        key.user_id,
        idempotency.key,
        idempotency.hash,
        now,
      );
      if (outcome) return idempotencyResponse(outcome);
    }
    throw err;
  }

  if (scheduledAt) {
    return Response.json({ id: outboundId });
  }

  const send = executeSend(env, ctx, key.user_id, body, {
    outboundId,
    idempotency,
    from,
    to,
    cc,
    bcc,
    replyTo: prep.replyTo,
    fromDomain,
    dom,
    tracking,
  });

  // Resend answers `POST /emails` as soon as the message is accepted, not
  // when the provider finishes. Doing the provider round-trip inline kept the
  // response at 4–9 s, which is too close to the 10 s timeout many clients
  // use (Hub retried and backed off, delaying verification mail by minutes).
  if (background && ctx) {
    ctx.waitUntil(send.catch((err) => markSendCrashed(env, outboundId, err)));
    return Response.json({ id: outboundId });
  }
  return send;
}

/**
 * Last-resort handler for an unexpected exception in the background send
 * (D1/R2 failure, not a provider refusal — those are recorded by
 * `executeSend` itself). Leaves the row observable instead of stuck in
 * 'sending' until the cron watchdog picks it up.
 */
async function markSendCrashed(env: Env, outboundId: string, err: unknown): Promise<void> {
  const message = `send crashed: ${String((err as Error)?.message ?? err)}`;
  try {
    const upd = await env.DB
      .prepare(
        `UPDATE outbound_messages SET status = 'failed', last_error = ?2
         WHERE id = ?1 AND status = 'sending'`,
      )
      .bind(outboundId, message)
      .run();
    if ((upd.meta.changes ?? 0) > 0) {
      await env.DB
        .prepare(
          `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
           SELECT ?1, owner_id, 'email.failed', ?2, ?2, ?3, ?4
           FROM outbound_messages WHERE id = ?2`,
        )
        .bind(
          newId.event(),
          outboundId,
          JSON.stringify({ error: message }),
          Date.now(),
        )
        .run();
    }
  } catch {
    // Best effort: the watchdog is the final safety net.
  }
  log.warn("email.send_crashed", { outbound_id: outboundId, error: message });
}

function idempotencyResponse(outcome: IdempotentReply): Response {
  return outcome.kind === "replay"
    ? Response.json({ id: outcome.id })
    : httpError.invalidIdempotentRequest();
}

interface PreparedSend {
  kind: "ok";
  from: Addr;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  fromDomain: string;
  dom: DomainRow;
  tracking: { opens: boolean; clicks: boolean };
}

// Validate addressing / domain / suppressions and resolve the tracking plan
// for a send request. Shared by the HTTP path and the cron sweep for
// scheduled sends (which re-validates at actual send time).
async function prepareSendContext(
  env: Env,
  userId: string,
  body: SendEmailBody,
): Promise<PreparedSend | { kind: "error"; message: string; response: Response }> {
  const fail = (message: string) => ({
    kind: "error" as const,
    message,
    response: httpError.validation(message),
  });

  const from = parseAddr(body.from as string);
  const to = asAddrList(body.to);
  const cc = asAddrList(body.cc);
  const bcc = asAddrList(body.bcc);
  const replyTo = asAddrList(body.reply_to);

  if (to.length === 0) {
    return fail("`to` must include at least one recipient");
  }
  if (to.length + cc.length + bcc.length > 50) {
    return fail("too many recipients (max 50)");
  }
  const bad = firstInvalid([from, ...to, ...cc, ...bcc, ...replyTo]);
  if (bad) return fail(`invalid address: ${bad}`);

  const fromDomain = domainOf(from.addr);
  if (!fromDomain) return fail("`from` address is malformed");
  const dom = await env.DB
    .prepare(
      `SELECT id, verification_status, open_tracking, click_tracking
       FROM domains WHERE owner_id = ?1 AND domain = ?2`,
    )
    .bind(userId, fromDomain)
    .first<DomainRow>();
  if (!dom) {
    return fail(`from domain ${fromDomain} not registered`);
  }
  if (dom.verification_status !== "verified") {
    return fail(`from domain ${fromDomain} is not verified yet`);
  }

  // Suppression pre-flight: block sends to addresses on the owner's hard-bounce
  // / complaint / manual suppression list. Better to fail explicitly than to
  // burn deliverability re-sending to a known-bad address.
  const allRcpts = [...to, ...cc, ...bcc].map((a) => a.addr);
  const blocked = await suppressionHits(env, userId, allRcpts);
  if (blocked.length) {
    return fail(`recipient(s) on suppression list: ${blocked.join(", ")}`);
  }

  // Resolve tracking plan up-front so the outbound_messages row records the
  // intended setting even if the HTML rewrite happens to be a no-op (e.g.
  // text-only send).
  const reqTracking =
    body.tracking && typeof body.tracking === "object"
      ? (body.tracking as { opens?: unknown; clicks?: unknown })
      : null;
  const tracking = {
    opens:
      reqTracking?.opens === undefined
        ? Boolean(dom.open_tracking)
        : Boolean(reqTracking.opens),
    clicks:
      reqTracking?.clicks === undefined
        ? Boolean(dom.click_tracking)
        : Boolean(reqTracking.clicks),
  };

  return { kind: "ok", from, to, cc, bcc, replyTo, fromDomain, dom, tracking };
}

interface SendContext {
  outboundId: string;
  idempotency: IdempotentSend | null;
  from: Addr;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  fromDomain: string;
  dom: DomainRow;
  tracking: { opens: boolean; clicks: boolean };
}

// The actual send: MIME build, per-recipient envelope sends, status update,
// inbox persistence, events + webhook fanout. The outbound_messages row must
// already exist in status 'sending'.
async function executeSend(
  env: Env,
  ctx: ExecutionContext | undefined,
  userId: string,
  body: SendEmailBody,
  sc: SendContext,
): Promise<Response> {
  if (!env.EMAIL) {
    return httpError.internal(
      "send_email binding not configured (Workers Paid plan + verified domain required)",
      503,
    );
  }
  const { outboundId, idempotency, from, to, cc, bcc, replyTo, fromDomain, dom, tracking } = sc;
  const messageId = newId.message();
  // We mint the RFC-5322 Message-ID at actual send time so it goes into the
  // outgoing MIME headers AND is what we persist; subsequent replies will
  // reference it via In-Reply-To, so it needs to be stable from here on.
  const rfc822MessageId = `${messageId}@${fromDomain}`;
  const now = Date.now();

  // HTML rewrite for tracking (pixel + click wrappers). This step generates
  // KV token rows tied to the outbound_id and mutates body.html in place.
  if (typeof body.html === "string" && (tracking.opens || tracking.clicks)) {
    body.html = await rewriteHtmlForTracking(
      body.html,
      env,
      userId,
      outboundId,
      tracking,
    );
  }

  // Build a single MIME message containing visible To/Cc headers; envelope
  // recipients (incl. Bcc) are split per send call.
  const mime = createMimeMessage();
  mime.setSender(from.name ? { name: from.name, addr: from.addr } : { addr: from.addr });
  if (to.length === 1) {
    mime.setTo(to[0]!.name ? { name: to[0]!.name!, addr: to[0]!.addr } : to[0]!.addr);
  } else {
    mime.setTo(to.map((a) => (a.name ? { name: a.name, addr: a.addr } : { addr: a.addr })));
  }
  if (cc.length) {
    mime.setCc(cc.map((a) => (a.name ? { name: a.name, addr: a.addr } : { addr: a.addr })));
  }
  if (replyTo.length) {
    mime.setHeader("Reply-To", replyTo.map((a) => a.addr).join(", "));
  }
  mime.setSubject(typeof body.subject === "string" ? body.subject : "");
  // Set Message-ID *before* any user-supplied headers so it's authoritative;
  // user-supplied `Message-ID` in body.headers below would be ignored.
  mime.setHeader("Message-ID", `<${rfc822MessageId}>`);
  if (typeof body.html === "string") mime.addMessage({ contentType: "text/html", data: body.html });
  if (typeof body.text === "string") mime.addMessage({ contentType: "text/plain", data: body.text });
  if (body.headers && typeof body.headers === "object") {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      // Don't let user override our Message-ID.
      if (k.toLowerCase() === "message-id") continue;
      if (typeof v === "string") mime.setHeader(k, v);
    }
  }
  const attachments = (body.attachments as Attachment[] | undefined) ?? [];
  for (const att of attachments) {
    if (typeof att.content === "string") {
      mime.addAttachment({
        filename: att.filename,
        contentType: att.content_type ?? "application/octet-stream",
        data: att.content,
        ...(att.content_id ? { headers: { "Content-ID": `<${att.content_id}>` } } : {}),
      });
    }
  }

  const rawMime = mime.asRaw();
  const envelopeRcpts = [...to, ...cc, ...bcc].map((a) => a.addr);

  let sentOk = 0;
  let lastError: string | null = null;
  for (const rcpt of envelopeRcpts) {
    try {
      const em = new EmailMessage(from.addr, rcpt, rawMime);
      await env.EMAIL.send(em);
      sentOk += 1;
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
      break;
    }
  }

  const status = sentOk === envelopeRcpts.length ? "sent" : "failed";
  await env.DB
    .prepare(
      `UPDATE outbound_messages
       SET status = ?2, attempts = ?3, last_error = ?4, sent_at = ?5
       WHERE id = ?1`,
    )
    .bind(
      outboundId,
      status,
      envelopeRcpts.length,
      lastError,
      status === "sent" ? Date.now() : null,
    )
    .run();
  // Cache the idempotency mapping only for successful sends; failed attempts
  // must stay retryable under the same key. The TTL is the remainder of the
  // key's 24 h window, never a fresh 24 h.
  if (idempotency && status === "sent") {
    await cacheIdempotentSend(
      env.KV,
      userId,
      idempotency.key,
      { id: outboundId, hash: idempotency.hash, createdAt: idempotency.createdAt },
      Date.now(),
    );
  }

  // Persist the sent mail into messages/threads so it appears in the inbox
  // alongside inbound mail, and replies can pull the original from R2.
  if (status === "sent") {
    const yyyy = new Date(now).getUTCFullYear();
    const mm = String(new Date(now).getUTCMonth() + 1).padStart(2, "0");
    const r2Key = `outbound/${yyyy}${mm}/${messageId}.eml`;
    await env.R2.put(r2Key, rawMime, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        msg_id: messageId,
        owner_id: userId,
        from: from.addr,
        outbound_id: outboundId,
      },
    });

    const inReplyToHeader =
      body.headers && typeof body.headers === "object"
        ? (body.headers as Record<string, unknown>)["In-Reply-To"]
        : undefined;
    const referencesHeader =
      body.headers && typeof body.headers === "object"
        ? (body.headers as Record<string, unknown>)["References"]
        : undefined;
    const refsArr = typeof referencesHeader === "string"
      ? referencesHeader.split(/\s+/).map((s) => s.replace(/^<|>$/g, "")).filter(Boolean)
      : [];

    const subj = typeof body.subject === "string" ? body.subject : "";
    const snippet = ((typeof body.text === "string" ? body.text : "") ||
      (typeof body.html === "string" ? body.html.replace(/<[^>]+>/g, " ") : "")
    ).trim().slice(0, 200) || null;

    await env.DB
      .prepare(
        `INSERT INTO messages
           (id, owner_id, domain_id, direction, rfc822_message_id,
            in_reply_to, references_json,
            from_addr, from_name, to_json, cc_json, bcc_json, reply_to,
            subject, snippet, received_at, sent_at, r2_key, size_bytes,
            has_attachments, attachment_count, parse_status, flags_bitmap, created_at)
         VALUES (?1, ?2, ?3, 'outbound', ?4,
                 ?5, ?6,
                 ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?15, ?16, ?17,
                 ?18, ?19, 'parsed', 1, ?15)`,
      )
      .bind(
        messageId,
        userId,
        dom.id,
        rfc822MessageId,
        typeof inReplyToHeader === "string" ? inReplyToHeader.replace(/^<|>$/g, "") : null,
        refsArr.length ? JSON.stringify(refsArr) : null,
        from.addr,
        from.name ?? null,
        JSON.stringify(to.map((a) => a.addr)),
        cc.length ? JSON.stringify(cc.map((a) => a.addr)) : null,
        bcc.length ? JSON.stringify(bcc.map((a) => a.addr)) : null,
        replyTo.length ? replyTo.map((a) => a.addr).join(", ") : null,
        subj,
        snippet,
        now,
        r2Key,
        rawMime.length,
        attachments.length > 0 ? 1 : 0,
        attachments.length,
      )
      .run();

    await env.DB
      .prepare(`UPDATE outbound_messages SET rendered_message_id = ?2 WHERE id = ?1`)
      .bind(outboundId, messageId)
      .run();

    await assignThread(env, messageId);
  }

  const sendEventId = newId.event();
  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`,
    )
    .bind(
      sendEventId,
      userId,
      status === "sent" ? "email.sent" : "email.failed",
      outboundId,
      JSON.stringify({ recipients: envelopeRcpts, error: lastError }),
      Date.now(),
    )
    .run();

  const webhookEvent = status === "sent" ? "email.sent" : "email.failed";
  const webhookData = {
    email_id: outboundId,
    from: from.addr,
    to: to.map((a) => a.addr),
    subject: typeof body.subject === "string" ? body.subject : "",
    last_error: lastError,
  };
  const dispatch = fanoutEvent(env, userId, webhookEvent, webhookData, sendEventId);
  if (ctx) {
    ctx.waitUntil(dispatch);
  } else {
    await dispatch;
  }

  log.info("email.sent_attempt", {
    outbound_id: outboundId,
    status,
    recipients: envelopeRcpts.length,
    error: lastError,
  });

  if (status !== "sent") {
    return httpError.internal(`send failed: ${lastError}`);
  }
  // Resend returns just { id }.
  return Response.json({ id: outboundId });
}

/**
 * Cron entry point: send outbound_messages whose scheduled_at has arrived.
 * Rows are claimed with a guarded status flip so overlapping cron invocations
 * (or a cron racing a PATCH/cancel) never double-send.
 */
export async function processScheduledSends(env: Env, ctx: ExecutionContext): Promise<void> {
  if (!env.EMAIL) return;
  const due = await env.DB
    .prepare(
      `SELECT id, owner_id, request_json FROM outbound_messages
       WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?1
       ORDER BY scheduled_at LIMIT 20`,
    )
    .bind(Date.now())
    .all<{ id: string; owner_id: string; request_json: string }>();

  for (const row of due.results ?? []) {
    const claim = await env.DB
      .prepare(
        `UPDATE outbound_messages SET status = 'sending' WHERE id = ?1 AND status = 'scheduled'`,
      )
      .bind(row.id)
      .run();
    if (!claim.meta.changes) continue;

    try {
      const body = JSON.parse(row.request_json) as SendEmailBody;
      // Re-validate at send time: the domain may have been deleted or a
      // recipient suppressed since the request was accepted.
      const prep = await prepareSendContext(env, row.owner_id, body);
      if (prep.kind === "error") {
        await env.DB
          .prepare(`UPDATE outbound_messages SET status = 'failed', last_error = ?2 WHERE id = ?1`)
          .bind(row.id, prep.message)
          .run();
        continue;
      }
      const res = await executeSend(env, ctx, row.owner_id, body, {
        outboundId: row.id,
        idempotency: null,
        from: prep.from,
        to: prep.to,
        cc: prep.cc,
        bcc: prep.bcc,
        replyTo: prep.replyTo,
        fromDomain: prep.fromDomain,
        dom: prep.dom,
        tracking: prep.tracking,
      });
      log.info("email.scheduled_send", { outbound_id: row.id, status: res.status });
    } catch (err) {
      await env.DB
        .prepare(`UPDATE outbound_messages SET status = 'failed', last_error = ?2 WHERE id = ?1`)
        .bind(row.id, String(err).slice(0, 500))
        .run();
    }
  }
}

/// A send still in 'sending' after this long is considered abandoned. The
/// provider round-trip plus persistence is bounded by seconds; the margin
/// covers a slow provider without racing a healthy send.
export const STUCK_SEND_MS = 10 * 60 * 1000;

/**
 * Cron watchdog: a row left in 'sending' (client disconnected before the
 * worker finished, isolate evicted, unexpected crash) used to stay there
 * forever. Mark it failed with a visible reason and an `email.failed` event
 * so it shows up in Activity and can be retried under the same Idempotency-Key
 * (checkIdempotencyKey releases failed rows).
 */
export async function reapStuckSends(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - STUCK_SEND_MS;
  const rows = await env.DB
    .prepare(
      `SELECT id, owner_id FROM outbound_messages
       WHERE status = 'sending' AND sent_at IS NULL AND created_at < ?1
       ORDER BY created_at
       LIMIT 100`,
    )
    .bind(cutoff)
    .all<{ id: string; owner_id: string }>();

  let reaped = 0;
  for (const row of rows.results ?? []) {
    const message = "send did not finish (timed out or the worker stopped)";
    const upd = await env.DB
      .prepare(
        `UPDATE outbound_messages SET status = 'failed', last_error = ?2
         WHERE id = ?1 AND status = 'sending'`,
      )
      .bind(row.id, message)
      .run();
    if (!upd.meta.changes) continue;
    reaped += 1;
    await env.DB
      .prepare(
        `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
         VALUES (?1, ?2, 'email.failed', ?3, ?3, ?4, ?5)`,
      )
      .bind(
        newId.event(),
        row.owner_id,
        row.id,
        JSON.stringify({ error: message }),
        now,
      )
      .run();
  }
  if (reaped > 0) log.warn("email.reaped_stuck_sends", { count: reaped });
  return reaped;
}

// Resend batch endpoint: array of email objects, ≤ 100, attachments + scheduled_at
// not supported (matches Resend's documented limits).
export async function handleEmailBatch(
  req: Request,
  env: Env,
  key: ApiKeyAuth,
): Promise<Response> {
  if (!key.scopes.includes("emails.send")) {
    return httpError.forbidden("API key lacks emails.send scope");
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  if (!Array.isArray(raw)) {
    return httpError.validation("request body must be an array of emails");
  }
  if (raw.length === 0) {
    return httpError.validation("batch must include at least one email");
  }
  if (raw.length > 100) {
    return httpError.validation("batch size exceeds 100");
  }
  for (const item of raw) {
    if (item && typeof item === "object" && "attachments" in (item as object)) {
      return httpError.validation("attachments not supported in batch");
    }
    if (item && typeof item === "object" && "scheduled_at" in (item as object)) {
      return httpError.validation("scheduled_at not supported in batch");
    }
  }

  // Idempotency applies to the batch as a whole. The header must NOT leak
  // into the per-item sends: they would all share one key, so item 1 would
  // be sent and items 2..n would replay item 1's id without sending.
  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (idempotencyKey) {
    const cached = await env.KV.get(`idem:batch:${key.user_id}:${idempotencyKey}`, "text");
    if (cached) {
      return new Response(cached, { headers: { "content-type": "application/json" } });
    }
  }
  const itemHeaders = new Headers(req.headers);
  itemHeaders.delete("Idempotency-Key");

  const data: Array<{ id: string }> = [];
  for (const item of raw) {
    const stubReq = new Request(req.url, {
      method: "POST",
      headers: itemHeaders,
      body: JSON.stringify(item),
    });
    const res = await handleEmailSend(stubReq, env, key);
    if (res.status >= 400) {
      // Stop batch on first error and return what succeeded. Don't record
      // the idempotency key: a retry should re-attempt the whole batch.
      const errBody = await res.clone().json();
      return Response.json(
        { object: "list", data, error: errBody },
        { status: res.status },
      );
    }
    const json = (await res.json()) as { id: string };
    data.push({ id: json.id });
  }
  const responseBody = JSON.stringify({ object: "list", data });
  if (idempotencyKey) {
    await env.KV.put(`idem:batch:${key.user_id}:${idempotencyKey}`, responseBody, {
      expirationTtl: 86400,
    });
  }
  return new Response(responseBody, { headers: { "content-type": "application/json" } });
}

export async function cancelOutboundMessage(
  env: Env,
  key: ApiKeyAuth,
  id: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!key.scopes.includes("emails.send")) {
    return httpError.forbidden("API key lacks emails.send scope");
  }
  const row = await env.DB
    .prepare(
      `SELECT id, status FROM outbound_messages WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, key.user_id)
    .first<{ id: string; status: string }>();
  if (!row) return httpError.notFound(`email ${id} not found`);

  if (row.status === "sent" || row.status === "delivered") {
    return httpError.validation(`cannot cancel an email that has already been ${row.status}`);
  }
  if (row.status === "canceled") {
    return Response.json({ object: "email", id: row.id, status: "canceled" });
  }
  await env.DB
    .prepare(`UPDATE outbound_messages SET status = 'canceled' WHERE id = ?1`)
    .bind(id)
    .run();
  const cancelEventId = newId.event();
  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, 'email.canceled', ?3, ?3, ?4, ?5)`,
    )
    .bind(cancelEventId, key.user_id, id, JSON.stringify({}), Date.now())
    .run();
  const dispatch = fanoutEvent(env, key.user_id, "email.canceled", { email_id: id }, cancelEventId);
  if (ctx) ctx.waitUntil(dispatch);
  else await dispatch;
  return Response.json({ object: "email", id: row.id, status: "canceled" });
}

export async function patchOutboundMessage(
  req: Request,
  env: Env,
  key: ApiKeyAuth,
  id: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!key.scopes.includes("emails.send")) {
    return httpError.forbidden("API key lacks emails.send scope");
  }
  const row = await env.DB
    .prepare(
      `SELECT id, status, scheduled_at FROM outbound_messages WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, key.user_id)
    .first<{ id: string; status: string; scheduled_at: number | null }>();
  if (!row) return httpError.notFound(`email ${id} not found`);
  if (row.status !== "scheduled" && row.status !== "queued") {
    return httpError.validation(`cannot update an email in status ${row.status}`);
  }

  let body: { scheduled_at?: unknown };
  try {
    body = (await req.json()) as { scheduled_at?: unknown };
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  if (typeof body.scheduled_at !== "string") {
    return httpError.validation("scheduled_at must be an ISO timestamp");
  }
  const ts = Date.parse(body.scheduled_at);
  if (Number.isNaN(ts)) {
    return httpError.validation("scheduled_at could not be parsed");
  }
  await env.DB
    .prepare(
      `UPDATE outbound_messages SET scheduled_at = ?2, status = 'scheduled' WHERE id = ?1`,
    )
    .bind(id, ts)
    .run();
  const schedEventId = newId.event();
  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, 'email.scheduled', ?3, ?3, ?4, ?5)`,
    )
    .bind(
      schedEventId,
      key.user_id,
      id,
      JSON.stringify({ scheduled_at: new Date(ts).toISOString() }),
      Date.now(),
    )
    .run();
  const dispatch = fanoutEvent(env, key.user_id, "email.scheduled", {
    email_id: id,
    scheduled_at: new Date(ts).toISOString(),
  }, schedEventId);
  if (ctx) ctx.waitUntil(dispatch);
  else await dispatch;
  return Response.json({
    object: "email",
    id: row.id,
    status: "scheduled",
    scheduled_at: new Date(ts).toISOString(),
  });
}

// Resend-style listing. The query, cursor and row shape live in ./outbound
// so the SPA's activity endpoints cannot drift from this one.
export async function listOutboundMessages(
  url: URL,
  env: Env,
  key: ApiKeyAuth,
): Promise<Response> {
  if (!key.scopes.includes("emails.read")) {
    return httpError.forbidden("API key lacks emails.read scope");
  }
  const page = await listOutboundRows(url, env, key.user_id);
  if (page instanceof Response) return page;
  return Response.json({
    object: "list",
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
    data: page.rows.map((r) => shapeOutbound(r, "api")),
  });
}

export async function getOutboundMessageEvents(
  env: Env,
  key: ApiKeyAuth,
  id: string,
): Promise<Response> {
  if (!key.scopes.includes("emails.read")) {
    return httpError.forbidden("API key lacks emails.read scope");
  }
  const data = await listOutboundEvents(env, key.user_id, id);
  if (!data) return httpError.notFound(`email ${id} not found`);
  return Response.json({ object: "list", email_id: id, data });
}

export async function getOutboundMessage(
  env: Env,
  key: ApiKeyAuth,
  id: string,
): Promise<Response> {
  if (!key.scopes.includes("emails.read")) {
    return httpError.forbidden("API key lacks emails.read scope");
  }
  const row = await getOutboundRow(env, key.user_id, id);
  if (!row) return httpError.notFound(`email ${id} not found`);
  return Response.json(shapeOutbound(row, "api"));
}
