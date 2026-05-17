import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";
import { newToken, sha256Hex, tokenPrefix } from "./apikey_auth";

interface ApiKeyRow {
  id: string;
  owner_id: string;
  name: string | null;
  prefix: string;
  scopes_json: string;
  domain_scope_json: string | null;
  last_used_at: number | null;
  created_at: number;
  revoked_at: number | null;
}

function shape(r: ApiKeyRow) {
  return {
    object: "api_key",
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: JSON.parse(r.scopes_json) as string[],
    domain_scope: r.domain_scope_json ? (JSON.parse(r.domain_scope_json) as string[]) : null,
    created_at: new Date(r.created_at).toISOString(),
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    revoked_at: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  };
}

export async function handleApiKeys(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1\/api-keys/, "");

  if ((path === "" || path === "/") && req.method === "GET") return listKeys(env, user);
  if ((path === "" || path === "/") && req.method === "POST") return createKey(req, env, user);

  const m = path.match(/^\/([^/]+)$/);
  if (m && req.method === "GET") return getKey(env, user, m[1]!);
  if (m && req.method === "DELETE") return revokeKey(env, user, m[1]!);

  return httpError.notFound(`api-keys route ${path} not found`);
}

async function listKeys(env: Env, user: AuthUser): Promise<Response> {
  const res = await env.DB
    .prepare(
      `SELECT id, owner_id, name, prefix, scopes_json, domain_scope_json,
              last_used_at, created_at, revoked_at
       FROM api_keys WHERE owner_id = ?1 ORDER BY created_at DESC`,
    )
    .bind(user.id)
    .all<ApiKeyRow>();
  return Response.json({
    object: "list",
    data: (res.results ?? []).map(shape),
  });
}

async function createKey(req: Request, env: Env, user: AuthUser): Promise<Response> {
  let body: { name?: unknown; scopes?: unknown; domain_scope?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  const name = typeof body.name === "string" ? body.name.trim() : null;
  const scopes = Array.isArray(body.scopes) && body.scopes.every((s) => typeof s === "string")
    ? (body.scopes as string[])
    : ["emails.send", "emails.read", "domains.read"];
  const domainScope = Array.isArray(body.domain_scope) && body.domain_scope.every((s) => typeof s === "string")
    ? (body.domain_scope as string[])
    : null;

  const token = newToken();
  const prefix = tokenPrefix(token);
  const hash = await sha256Hex(token);
  const id = newId.apiKey();
  const now = Date.now();

  await env.DB
    .prepare(
      `INSERT INTO api_keys (id, owner_id, name, prefix, key_hash, scopes_json, domain_scope_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      id,
      user.id,
      name,
      prefix,
      hash,
      JSON.stringify(scopes),
      domainScope ? JSON.stringify(domainScope) : null,
      now,
    )
    .run();

  return Response.json(
    {
      object: "api_key",
      id,
      name,
      prefix,
      scopes,
      domain_scope: domainScope,
      created_at: new Date(now).toISOString(),
      token, // ONLY returned at creation time
    },
    { status: 201 },
  );
}

async function getKey(env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, owner_id, name, prefix, scopes_json, domain_scope_json,
              last_used_at, created_at, revoked_at
       FROM api_keys WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<ApiKeyRow>();
  if (!row) return httpError.notFound(`api key ${id} not found`);
  return Response.json(shape(row));
}

async function revokeKey(env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await env.DB
    .prepare(`SELECT id, prefix, revoked_at FROM api_keys WHERE id = ?1 AND owner_id = ?2`)
    .bind(id, user.id)
    .first<{ id: string; prefix: string; revoked_at: number | null }>();
  if (!row) return httpError.notFound(`api key ${id} not found`);
  if (row.revoked_at == null) {
    await env.DB
      .prepare(`UPDATE api_keys SET revoked_at = ?2 WHERE id = ?1`)
      .bind(id, Date.now())
      .run();
  }
  await env.KV.delete(`apikey:${row.prefix}`);
  return Response.json({ object: "api_key", id, deleted: true });
}
