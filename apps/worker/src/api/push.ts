// Web Push subscriptions and delivery. The client supplies the standard
// PushSubscription JSON; the Worker encrypts (RFC 8291) and signs (RFC 8292)
// with VAPID keys configured as secrets.

import {
  buildPushPayload,
  type PushSubscription,
  type VapidKeys,
} from "@block65/webcrypto-web-push";
import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";
import { log } from "../utils/log";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

function vapid(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return null;
  }
  return {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
}

export async function handlePush(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1\/push/, "");

  if (path === "/key" && req.method === "GET") {
    const keys = vapid(env);
    return Response.json({
      object: "push_key",
      enabled: Boolean(keys),
      public_key: env.VAPID_PUBLIC_KEY ?? null,
    });
  }

  if (path === "/subscribe" && req.method === "POST") {
    return subscribe(req, env, user);
  }
  if (path === "/subscribe" && req.method === "DELETE") {
    return unsubscribe(url, req, env, user);
  }

  return httpError.notFound(`push route ${path} not found`);
}

async function subscribe(req: Request, env: Env, user: AuthUser): Promise<Response> {
  let body: {
    endpoint?: unknown;
    expirationTime?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return httpError.validation("endpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    return httpError.validation("push endpoint must be https");
  }
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!p256dh || !auth || p256dh.length > 500 || auth.length > 500) {
    return httpError.validation("keys.p256dh and keys.auth are required");
  }

  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO push_subscriptions
         (id, owner_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(owner_id, endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      newId.pushSubscription(),
      user.id,
      endpoint,
      p256dh,
      auth,
      req.headers.get("user-agent"),
      now,
    )
    .run();

  log.info("push.subscribed", { owner_id: user.id });
  return Response.json(
    { object: "push_subscription", endpoint, subscribed: true },
    { status: 201 },
  );
}

async function unsubscribe(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  let endpoint = url.searchParams.get("endpoint") ?? "";
  if (!endpoint) {
    try {
      const body = (await req.json()) as { endpoint?: unknown };
      if (typeof body.endpoint === "string") endpoint = body.endpoint;
    } catch {
      // A query parameter is the other accepted form.
    }
  }
  if (!endpoint) return httpError.validation("endpoint is required");

  await env.DB
    .prepare(`DELETE FROM push_subscriptions WHERE owner_id = ?1 AND endpoint = ?2`)
    .bind(user.id, endpoint)
    .run();
  return Response.json({ object: "push_subscription", endpoint, deleted: true });
}

/**
 * Deliver a notification to every browser/device subscribed by this owner.
 * Failures are logged per endpoint and never escape into the mail pipeline.
 */
export async function sendPushToOwner(
  env: Env,
  ownerId: string,
  message: PushPayload,
): Promise<void> {
  const keys = vapid(env);
  if (!keys) return;

  const rows = await env.DB
    .prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
       WHERE owner_id = ?1 ORDER BY created_at DESC`,
    )
    .bind(ownerId)
    .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
  const subs = rows.results ?? [];
  if (subs.length === 0) return;

  const data = {
    title: message.title.slice(0, 120),
    body: message.body.slice(0, 240),
    url: message.url ?? "/inbox",
    ...(message.tag ? { tag: message.tag } : {}),
  };

  for (const sub of subs) {
    const subscription: PushSubscription = {
      endpoint: sub.endpoint,
      expirationTime: null,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      const payload = await buildPushPayload(
        { data, options: { ttl: 3600, urgency: "normal" } },
        subscription,
        keys,
      );
      const res = await fetch(sub.endpoint, payload);
      if (res.status === 404 || res.status === 410) {
        await env.DB
          .prepare(`DELETE FROM push_subscriptions WHERE id = ?1`)
          .bind(sub.id)
          .run();
      } else if (!res.ok) {
        log.warn("push.delivery_failed", {
          status: res.status,
          endpoint: sub.endpoint.slice(0, 100),
        });
      }
    } catch (err) {
      log.warn("push.send_failed", {
        endpoint: sub.endpoint.slice(0, 100),
        error: String(err),
      });
    }
  }
}
