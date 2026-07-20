import type { Env } from "../env";
import { newId } from "../ids";
import { log } from "../utils/log";

// Svix Standard Webhooks signing.
//   sign(payload) = HMAC-SHA256(secret_bytes, `${id}.${timestamp}.${body}`)
//   header: svix-signature: v1,<base64(sig)>
//   secret format: whsec_<base64(raw_secret_bytes)>

const SECRET_PREFIX = "whsec_";

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function svixSign(
  secret: string,
  msgId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const keyBytes = bytesFromBase64(raw);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const toSign = `${msgId}.${timestamp}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(toSign));
  return `v1,${bytesToBase64(new Uint8Array(sig))}`;
}

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
  event_types_json: string;
  enabled: number;
}

interface WebhookPayload {
  type: string;
  created_at: string;
  data: Record<string, unknown>;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;
// Backoff after attempt N (1-based): 5m, 30m, 2h, 5h. Attempt 5 failing → dead.
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000, 5 * 3600_000];

interface AttemptResult {
  ok: boolean;
  code: number | null;
  err: string | null;
}

/** One signed POST to an endpoint. Never throws. */
async function attemptDelivery(
  secret: string,
  url: string,
  msgId: string,
  body: string,
): Promise<AttemptResult> {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await svixSign(secret, msgId, timestamp, body);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": msgId,
        "svix-timestamp": String(timestamp),
        "svix-signature": signature,
        "webhook-id": msgId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature,
        "user-agent": "domain-inbox-webhooks/1.0",
      },
      body,
      // A subscriber that accepts the connection and never responds must not
      // stall the fanout loop (or, worse, the whole waitUntil budget).
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return {
      ok: res.ok,
      code: res.status,
      err: res.ok ? null : `upstream ${res.status}`,
    };
  } catch (e) {
    return { ok: false, code: null, err: String((e as Error)?.message ?? e) };
  }
}

/**
 * Fan out an event to all of the owner's enabled webhook endpoints subscribed
 * to the event type. Records each delivery attempt in webhook_deliveries;
 * failures are scheduled for retry by the cron-driven
 * retryPendingWebhookDeliveries.
 *
 * `eventId` is the events-table row id (for audit joins); pass null when no
 * event row exists.
 *
 * Caller should wrap the returned promise with ctx.waitUntil to avoid blocking
 * the request hot path.
 */
export async function fanoutEvent(
  env: Env,
  ownerId: string,
  type: string,
  data: Record<string, unknown>,
  eventId: string | null = null,
): Promise<void> {
  const endpoints = await env.DB
    .prepare(
      `SELECT id, url, secret, event_types_json, enabled
       FROM webhook_endpoints WHERE owner_id = ?1 AND enabled = 1`,
    )
    .bind(ownerId)
    .all<EndpointRow>();

  const payload: WebhookPayload = {
    type,
    created_at: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);

  for (const ep of endpoints.results ?? []) {
    let events: string[];
    try {
      events = JSON.parse(ep.event_types_json) as string[];
    } catch {
      continue;
    }
    if (!events.includes(type)) continue;

    // Per-endpoint isolation: one endpoint with a bad secret or URL must not
    // abort delivery to the remaining endpoints.
    try {
      const msgId = newId.webhookMessage();
      const deliveryId = newId.webhookDelivery();
      const result = await attemptDelivery(ep.secret, ep.url, msgId, body);
      const now = Date.now();

      await env.DB
        .prepare(
          `INSERT INTO webhook_deliveries
             (id, endpoint_id, event_id, event_type, payload_json, svix_msg_id,
              status, response_code, attempts, next_retry_at, last_error,
              created_at, delivered_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11, ?12)`,
        )
        .bind(
          deliveryId,
          ep.id,
          eventId,
          type,
          body,
          msgId,
          result.ok ? "sent" : "failed",
          result.code,
          result.ok ? null : Date.now() + RETRY_DELAYS_MS[0]!,
          result.err,
          now,
          result.ok ? now : null,
        )
        .run();

      log.info("webhook.delivered", {
        delivery_id: deliveryId,
        endpoint_id: ep.id,
        event_type: type,
        status: result.ok ? "sent" : "failed",
        response_code: result.code,
        error: result.err,
      });
    } catch (e) {
      log.warn("webhook.fanout_endpoint_failed", {
        endpoint_id: ep.id,
        event_type: type,
        error: String(e),
      });
    }
  }
}

interface RetryRow {
  id: string;
  endpoint_id: string;
  svix_msg_id: string | null;
  payload_json: string | null;
  attempts: number;
  url: string;
  secret: string;
  enabled: number;
}

/**
 * Cron entry point: re-attempt failed deliveries whose next_retry_at has
 * passed. Keeps the svix msg id stable across attempts (Standard Webhooks
 * semantics) while signing with a fresh timestamp. After MAX_ATTEMPTS the
 * delivery is marked dead.
 */
export async function retryPendingWebhookDeliveries(env: Env): Promise<void> {
  const now = Date.now();
  const due = await env.DB
    .prepare(
      `SELECT wd.id, wd.endpoint_id, wd.svix_msg_id, wd.payload_json, wd.attempts,
              ep.url, ep.secret, ep.enabled
       FROM webhook_deliveries wd
       JOIN webhook_endpoints ep ON ep.id = wd.endpoint_id
       WHERE wd.status IN ('pending', 'failed')
         AND wd.attempts < ?1
         AND wd.next_retry_at IS NOT NULL
         AND wd.next_retry_at <= ?2
       ORDER BY wd.next_retry_at
       LIMIT 50`,
    )
    .bind(MAX_ATTEMPTS, now)
    .all<RetryRow>();

  for (const row of due.results ?? []) {
    // Endpoint disabled since, or a pre-0007 row without a payload snapshot:
    // nothing useful to retry.
    if (!row.enabled || !row.payload_json) {
      await env.DB
        .prepare(`UPDATE webhook_deliveries SET status = 'dead' WHERE id = ?1`)
        .bind(row.id)
        .run();
      continue;
    }

    const msgId = row.svix_msg_id ?? newId.webhookMessage();
    const result = await attemptDelivery(row.secret, row.url, msgId, row.payload_json);
    const attempts = row.attempts + 1;
    const exhausted = !result.ok && attempts >= MAX_ATTEMPTS;
    const nextDelay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;

    await env.DB
      .prepare(
        `UPDATE webhook_deliveries
         SET status = ?2, response_code = ?3, attempts = ?4,
             next_retry_at = ?5, last_error = ?6, delivered_at = ?7
         WHERE id = ?1`,
      )
      .bind(
        row.id,
        result.ok ? "sent" : exhausted ? "dead" : "failed",
        result.code,
        attempts,
        result.ok || exhausted ? null : Date.now() + nextDelay,
        result.err,
        result.ok ? Date.now() : null,
      )
      .run();

    log.info("webhook.retried", {
      delivery_id: row.id,
      endpoint_id: row.endpoint_id,
      attempts,
      status: result.ok ? "sent" : exhausted ? "dead" : "failed",
      response_code: result.code,
      error: result.err,
    });
  }
}
