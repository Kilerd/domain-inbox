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

/**
 * Fan out an event to all of the owner's enabled webhook endpoints subscribed
 * to the event type. Records each delivery attempt in webhook_deliveries.
 *
 * Caller should wrap the returned promise with ctx.waitUntil to avoid blocking
 * the request hot path.
 */
export async function fanoutEvent(
  env: Env,
  ownerId: string,
  type: string,
  data: Record<string, unknown>,
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

    const msgId = newId.webhookMessage();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await svixSign(ep.secret, msgId, timestamp, body);
    const deliveryId = newId.webhookDelivery();
    const now = Date.now();

    let status: "sent" | "failed" = "failed";
    let code: number | null = null;
    let err: string | null = null;
    try {
      const res = await fetch(ep.url, {
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
      });
      code = res.status;
      status = res.ok ? "sent" : "failed";
      if (!res.ok) err = `upstream ${res.status}`;
    } catch (e) {
      err = String((e as Error)?.message ?? e);
    }

    await env.DB
      .prepare(
        `INSERT INTO webhook_deliveries
           (id, endpoint_id, event_id, status, response_code, attempts, created_at, delivered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)`,
      )
      .bind(
        deliveryId,
        ep.id,
        msgId,
        status,
        code,
        now,
        status === "sent" ? now : null,
      )
      .run();

    log.info("webhook.delivered", {
      delivery_id: deliveryId,
      endpoint_id: ep.id,
      event_type: type,
      status,
      response_code: code,
      error: err,
    });
  }
}
