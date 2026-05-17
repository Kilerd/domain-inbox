import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import type { ApiKeyAuth } from "./apikey_auth";
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

  const from = parseAddr(body.from);
  const to = asAddrList(body.to);
  const cc = asAddrList(body.cc);
  const bcc = asAddrList(body.bcc);
  const replyTo = asAddrList(body.reply_to);

  if (to.length === 0) {
    return httpError.validation("`to` must include at least one recipient");
  }
  if (to.length + cc.length + bcc.length > 50) {
    return httpError.validation("too many recipients (max 50)");
  }
  const bad = firstInvalid([from, ...to, ...cc, ...bcc, ...replyTo]);
  if (bad) return httpError.validation(`invalid address: ${bad}`);

  const fromDomain = domainOf(from.addr);
  if (!fromDomain) return httpError.validation("`from` address is malformed");
  const dom = await env.DB
    .prepare(
      `SELECT id, verification_status, open_tracking, click_tracking
       FROM domains WHERE owner_id = ?1 AND domain = ?2`,
    )
    .bind(key.user_id, fromDomain)
    .first<DomainRow>();
  if (!dom) {
    return httpError.validation(`from domain ${fromDomain} not registered`);
  }
  if (dom.verification_status !== "verified") {
    return httpError.validation(`from domain ${fromDomain} is not verified yet`);
  }
  if (
    key.domain_scope &&
    !key.domain_scope.includes(dom.id) &&
    !key.domain_scope.includes(fromDomain)
  ) {
    return httpError.forbidden(`API key not scoped to send from ${fromDomain}`);
  }

  // Suppression pre-flight: block sends to addresses on the owner's hard-bounce
  // / complaint / manual suppression list. Better to fail explicitly than to
  // burn deliverability re-sending to a known-bad address.
  const allRcpts = [...to, ...cc, ...bcc].map((a) => a.addr);
  const blocked = await suppressionHits(env, key.user_id, allRcpts);
  if (blocked.length) {
    return httpError.validation(
      `recipient(s) on suppression list: ${blocked.join(", ")}`,
    );
  }

  // Idempotency: return prior outbound id on replay.
  if (idempotencyKey) {
    const cached = await env.KV.get<string>(
      `idem:${key.user_id}:${idempotencyKey}`,
      "text",
    );
    if (cached) return Response.json({ id: cached });
    const existing = await env.DB
      .prepare(
        `SELECT id FROM outbound_messages WHERE owner_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(key.user_id, idempotencyKey)
      .first<{ id: string }>();
    if (existing) {
      await env.KV.put(`idem:${key.user_id}:${idempotencyKey}`, existing.id, {
        expirationTtl: 86400,
      });
      return Response.json({ id: existing.id });
    }
  }

  const outboundId = newId.outbound();
  const messageId = newId.message();
  // We mint the RFC-5322 Message-ID up front so it goes into the outgoing MIME
  // headers AND is what we persist; this is also what subsequent replies will
  // reference via In-Reply-To, so it needs to be stable.
  const rfc822MessageId = `${messageId}@${fromDomain}`;
  const now = Date.now();

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
  const trackingFlag = tracking.opens || tracking.clicks ? 1 : 0;

  // Pre-record so failures are observable.
  await env.DB
    .prepare(
      `INSERT INTO outbound_messages
         (id, owner_id, api_key_id, idempotency_key, status, channel,
          request_json, attempts, template_id, tracking_enabled, created_at)
       VALUES (?1, ?2, ?3, ?4, 'sending', 'cf_native', ?5, 0, ?6, ?7, ?8)`,
    )
    .bind(
      outboundId,
      key.user_id,
      key.key_id,
      idempotencyKey ?? null,
      JSON.stringify(body),
      templateId,
      trackingFlag,
      now,
    )
    .run();
  if (idempotencyKey) {
    await env.KV.put(`idem:${key.user_id}:${idempotencyKey}`, outboundId, {
      expirationTtl: 86400,
    });
  }

  // HTML rewrite for tracking (pixel + click wrappers). Tracking plan was
  // resolved before the outbound_messages insert above; this step generates
  // KV token rows tied to the outbound_id and mutates body.html in place.
  if (typeof body.html === "string" && (tracking.opens || tracking.clicks)) {
    body.html = await rewriteHtmlForTracking(
      body.html,
      env,
      key.user_id,
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
    mime.setTo(to.map((a) => (a.name ? { name: a.name, addr: a.addr } : a.addr)));
  }
  if (cc.length) {
    mime.setCc(cc.map((a) => (a.name ? { name: a.name, addr: a.addr } : a.addr)));
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
        owner_id: key.user_id,
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
        key.user_id,
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

    // SSE beacon so any open inbox tab refreshes.
    await env.KV.put(`inbox:lastUpdate:${key.user_id}`, String(Date.now()), {
      expirationTtl: 86400,
    });
  }

  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`,
    )
    .bind(
      newId.event(),
      key.user_id,
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
  const dispatch = fanoutEvent(env, key.user_id, webhookEvent, webhookData);
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

  const data: Array<{ id: string }> = [];
  for (const item of raw) {
    const stubReq = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(item),
    });
    const res = await handleEmailSend(stubReq, env, key);
    if (res.status >= 400) {
      // Stop batch on first error and return what succeeded.
      const errBody = await res.clone().json();
      return Response.json(
        { object: "list", data, error: errBody },
        { status: res.status },
      );
    }
    const json = (await res.json()) as { id: string };
    data.push({ id: json.id });
  }
  return Response.json({ object: "list", data });
}

export async function cancelOutboundMessage(
  env: Env,
  key: ApiKeyAuth,
  id: string,
  ctx?: ExecutionContext,
): Promise<Response> {
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
  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, 'email.canceled', ?3, ?3, ?4, ?5)`,
    )
    .bind(newId.event(), key.user_id, id, JSON.stringify({}), Date.now())
    .run();
  const dispatch = fanoutEvent(env, key.user_id, "email.canceled", { email_id: id });
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
  await env.DB
    .prepare(
      `INSERT INTO events (id, owner_id, type, outbound_id, email_id, payload_json, created_at)
       VALUES (?1, ?2, 'email.scheduled', ?3, ?3, ?4, ?5)`,
    )
    .bind(
      newId.event(),
      key.user_id,
      id,
      JSON.stringify({ scheduled_at: new Date(ts).toISOString() }),
      Date.now(),
    )
    .run();
  const dispatch = fanoutEvent(env, key.user_id, "email.scheduled", {
    email_id: id,
    scheduled_at: new Date(ts).toISOString(),
  });
  if (ctx) ctx.waitUntil(dispatch);
  else await dispatch;
  return Response.json({
    object: "email",
    id: row.id,
    status: "scheduled",
    scheduled_at: new Date(ts).toISOString(),
  });
}

// Resend-style listing: cursor pagination over outbound_messages with
// optional filters. The cursor is the created_at of the last row from the
// previous page (descending order); ties on created_at fall through to id
// lexicographically so we don't skip or duplicate rows.
export async function listOutboundMessages(
  url: URL,
  env: Env,
  key: ApiKeyAuth,
): Promise<Response> {
  if (!key.scopes.includes("emails.read")) {
    return httpError.forbidden("API key lacks emails.read scope");
  }
  const status = url.searchParams.get("status");
  const domainFilter = url.searchParams.get("domain");
  const apiKeyFilter = url.searchParams.get("api_key");
  const createdAfter = url.searchParams.get("created_after");
  const createdBefore = url.searchParams.get("created_before");
  const cursor = url.searchParams.get("cursor");
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100);

  const filters: string[] = ["om.owner_id = ?1"];
  const binds: Array<string | number> = [key.user_id];

  if (status) {
    filters.push(`om.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (apiKeyFilter) {
    filters.push(`om.api_key_id = ?${binds.length + 1}`);
    binds.push(apiKeyFilter);
  }
  if (createdAfter) {
    const ts = Date.parse(createdAfter);
    if (Number.isNaN(ts)) return httpError.validation("created_after must be ISO8601");
    filters.push(`om.created_at >= ?${binds.length + 1}`);
    binds.push(ts);
  }
  if (createdBefore) {
    const ts = Date.parse(createdBefore);
    if (Number.isNaN(ts)) return httpError.validation("created_before must be ISO8601");
    filters.push(`om.created_at < ?${binds.length + 1}`);
    binds.push(ts);
  }
  if (cursor) {
    // cursor = "<created_at>:<id>"
    const [tsRaw, idRaw] = cursor.split(":");
    const ts = parseInt(tsRaw ?? "", 10);
    if (Number.isNaN(ts) || !idRaw) return httpError.validation("invalid cursor");
    filters.push(
      `(om.created_at < ?${binds.length + 1} OR (om.created_at = ?${binds.length + 1} AND om.id < ?${binds.length + 2}))`,
    );
    binds.push(ts, idRaw);
  }

  if (domainFilter) {
    // Filter by the from-domain extracted from request_json. SQLite's json1
    // extension is on by default in D1, so this is one indexable expression
    // rather than a scan + LIKE pattern.
    filters.push(
      `json_extract(om.request_json, '$.from') LIKE ?${binds.length + 1}`,
    );
    binds.push(`%@${domainFilter}%`);
  }

  const sql = `
    SELECT om.id, om.status, om.created_at, om.sent_at, om.scheduled_at, om.bounced_at,
           om.bounce_type, om.bounce_diag, om.last_error,
           om.template_id, om.tracking_enabled, om.open_count, om.click_count,
           om.first_opened_at, om.last_opened_at, om.first_clicked_at, om.last_clicked_at,
           om.api_key_id, om.idempotency_key, om.request_json
    FROM outbound_messages om
    WHERE ${filters.join(" AND ")}
    ORDER BY om.created_at DESC, om.id DESC
    LIMIT ${limit + 1}
  `;
  const res = await env.DB.prepare(sql).bind(...binds).all<{
    id: string;
    status: string;
    created_at: number;
    sent_at: number | null;
    scheduled_at: number | null;
    bounced_at: number | null;
    bounce_type: string | null;
    bounce_diag: string | null;
    last_error: string | null;
    template_id: string | null;
    tracking_enabled: number;
    open_count: number;
    click_count: number;
    first_opened_at: number | null;
    last_opened_at: number | null;
    first_clicked_at: number | null;
    last_clicked_at: number | null;
    api_key_id: string;
    idempotency_key: string | null;
    request_json: string;
  }>();
  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const next = hasMore && page.length
    ? `${page[page.length - 1]!.created_at}:${page[page.length - 1]!.id}`
    : null;

  return Response.json({
    object: "list",
    has_more: hasMore,
    next_cursor: next,
    data: page.map((r) => {
      const req = JSON.parse(r.request_json) as Record<string, unknown>;
      return {
        object: "email",
        id: r.id,
        status: r.status,
        created_at: new Date(r.created_at).toISOString(),
        sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
        scheduled_at: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null,
        bounced_at: r.bounced_at ? new Date(r.bounced_at).toISOString() : null,
        bounce_type: r.bounce_type,
        bounce_diag: r.bounce_diag,
        last_error: r.last_error,
        from: req.from,
        to: req.to,
        cc: req.cc ?? null,
        bcc: req.bcc ?? null,
        subject: req.subject ?? null,
        template_id: r.template_id,
        api_key_id: r.api_key_id,
        idempotency_key: r.idempotency_key,
        tracking: {
          enabled: Boolean(r.tracking_enabled),
          open_count: r.open_count,
          click_count: r.click_count,
          first_opened_at: r.first_opened_at ? new Date(r.first_opened_at).toISOString() : null,
          last_opened_at: r.last_opened_at ? new Date(r.last_opened_at).toISOString() : null,
          first_clicked_at: r.first_clicked_at ? new Date(r.first_clicked_at).toISOString() : null,
          last_clicked_at: r.last_clicked_at ? new Date(r.last_clicked_at).toISOString() : null,
        },
      };
    }),
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
  const owns = await env.DB
    .prepare(`SELECT id FROM outbound_messages WHERE id = ?1 AND owner_id = ?2`)
    .bind(id, key.user_id)
    .first<{ id: string }>();
  if (!owns) return httpError.notFound(`email ${id} not found`);

  const res = await env.DB
    .prepare(
      `SELECT id, type, payload_json, created_at
       FROM events
       WHERE owner_id = ?1 AND (outbound_id = ?2 OR email_id = ?2)
       ORDER BY created_at ASC`,
    )
    .bind(key.user_id, id)
    .all<{ id: string; type: string; payload_json: string; created_at: number }>();
  return Response.json({
    object: "list",
    email_id: id,
    data: (res.results ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      created_at: new Date(r.created_at).toISOString(),
      data: JSON.parse(r.payload_json),
    })),
  });
}

export async function getOutboundMessage(
  env: Env,
  key: ApiKeyAuth,
  id: string,
): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, status, created_at, sent_at, scheduled_at, channel, last_error,
              request_json
       FROM outbound_messages WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, key.user_id)
    .first<{
      id: string;
      status: string;
      created_at: number;
      sent_at: number | null;
      scheduled_at: number | null;
      channel: string;
      last_error: string | null;
      request_json: string;
    }>();
  if (!row) return httpError.notFound(`email ${id} not found`);

  const req = JSON.parse(row.request_json) as Record<string, unknown>;
  return Response.json({
    object: "email",
    id: row.id,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    scheduled_at: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    from: req.from,
    to: req.to,
    cc: req.cc,
    bcc: req.bcc,
    subject: req.subject,
    last_error: row.last_error,
  });
}
