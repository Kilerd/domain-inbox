import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";

const SECRET_PREFIX = "whsec_";
const SUPPORTED_EVENTS = new Set([
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.scheduled",
  "email.received",
]);

interface EndpointRow {
  id: string;
  owner_id: string;
  url: string;
  secret: string;
  event_types_json: string;
  enabled: number;
  created_at: number;
}

function newSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return SECRET_PREFIX + btoa(bin);
}

function shape(r: EndpointRow) {
  return {
    object: "webhook_endpoint",
    id: r.id,
    url: r.url,
    events: JSON.parse(r.event_types_json) as string[],
    enabled: Boolean(r.enabled),
    created_at: new Date(r.created_at).toISOString(),
  };
}

export async function handleWebhooks(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1\/webhooks/, "");

  if ((path === "" || path === "/") && req.method === "GET") return listEndpoints(env, user);
  if ((path === "" || path === "/") && req.method === "POST") return createEndpoint(req, env, user);

  const m = path.match(/^\/([^/]+)$/);
  if (m && req.method === "GET") return getEndpoint(env, user, m[1]!);
  if (m && req.method === "PATCH") return patchEndpoint(req, env, user, m[1]!);
  if (m && req.method === "DELETE") return deleteEndpoint(env, user, m[1]!);

  return httpError.notFound(`webhooks route ${path} not found`);
}

async function listEndpoints(env: Env, user: AuthUser): Promise<Response> {
  const res = await env.DB
    .prepare(
      `SELECT id, owner_id, url, secret, event_types_json, enabled, created_at
       FROM webhook_endpoints WHERE owner_id = ?1 ORDER BY created_at DESC`,
    )
    .bind(user.id)
    .all<EndpointRow>();
  return Response.json({
    object: "list",
    data: (res.results ?? []).map(shape),
  });
}

async function createEndpoint(req: Request, env: Env, user: AuthUser): Promise<Response> {
  let body: { url?: unknown; events?: unknown; enabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  if (typeof body.url !== "string" || !/^https?:\/\//i.test(body.url)) {
    return httpError.validation("url must be a http(s) URL");
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return httpError.validation("events must be a non-empty array");
  }
  const events = (body.events as string[]).filter((e) => typeof e === "string");
  const bad = events.find((e) => !SUPPORTED_EVENTS.has(e));
  if (bad) {
    return httpError.validation(`unsupported event type: ${bad}`);
  }

  const id = newId.webhookEndpoint();
  const secret = newSecret();
  const now = Date.now();
  const enabled = body.enabled === false ? 0 : 1;

  await env.DB
    .prepare(
      `INSERT INTO webhook_endpoints (id, owner_id, url, secret, event_types_json, enabled, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(id, user.id, body.url, secret, JSON.stringify(events), enabled, now)
    .run();

  return Response.json(
    {
      object: "webhook_endpoint",
      id,
      url: body.url,
      events,
      enabled: Boolean(enabled),
      created_at: new Date(now).toISOString(),
      secret, // returned only at creation time
    },
    { status: 201 },
  );
}

async function getEndpoint(env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, owner_id, url, secret, event_types_json, enabled, created_at
       FROM webhook_endpoints WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<EndpointRow>();
  if (!row) return httpError.notFound(`webhook ${id} not found`);
  return Response.json(shape(row));
}

async function patchEndpoint(req: Request, env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, owner_id, url, secret, event_types_json, enabled, created_at
       FROM webhook_endpoints WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<EndpointRow>();
  if (!row) return httpError.notFound(`webhook ${id} not found`);

  let body: { url?: unknown; events?: unknown; enabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  const newUrl = typeof body.url === "string" ? body.url : row.url;
  const newEvents = Array.isArray(body.events)
    ? (body.events as string[]).filter((e) => typeof e === "string")
    : (JSON.parse(row.event_types_json) as string[]);
  const newEnabled =
    typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : row.enabled;

  await env.DB
    .prepare(
      `UPDATE webhook_endpoints SET url = ?2, event_types_json = ?3, enabled = ?4 WHERE id = ?1`,
    )
    .bind(id, newUrl, JSON.stringify(newEvents), newEnabled)
    .run();

  return Response.json(
    shape({ ...row, url: newUrl, event_types_json: JSON.stringify(newEvents), enabled: newEnabled }),
  );
}

async function deleteEndpoint(env: Env, user: AuthUser, id: string): Promise<Response> {
  await env.DB
    .prepare(`DELETE FROM webhook_endpoints WHERE id = ?1 AND owner_id = ?2`)
    .bind(id, user.id)
    .run();
  return Response.json({ object: "webhook_endpoint", id, deleted: true });
}
