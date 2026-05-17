import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";

interface AllowlistRow {
  email: string;
  role: string;
  invited_by_user_id: string | null;
  created_at: number;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  created_at: number;
  last_seen_at: number | null;
}

async function ensureOwner(env: Env, user: AuthUser): Promise<Response | null> {
  const row = await env.DB
    .prepare(`SELECT role FROM users WHERE id = ?1`)
    .bind(user.id)
    .first<{ role: string }>();
  if (row?.role !== "owner") {
    return httpError.forbidden("only owner can manage members");
  }
  return null;
}

export async function handleMembers(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  const denied = await ensureOwner(env, user);
  if (denied) return denied;

  const path = url.pathname.replace(/^\/api\/v1\/members/, "");

  if ((path === "" || path === "/") && req.method === "GET") return listMembers(env);
  if ((path === "" || path === "/") && req.method === "POST") return inviteMember(req, env, user);

  const m = path.match(/^\/([^/]+)$/);
  if (m && req.method === "DELETE") return removeMember(env, m[1]!);

  return httpError.notFound(`members route ${path} not found`);
}

async function listMembers(env: Env): Promise<Response> {
  const users = await env.DB
    .prepare(
      `SELECT id, email, name, role, created_at, last_seen_at FROM users ORDER BY created_at`,
    )
    .all<UserRow>();
  const invited = await env.DB
    .prepare(
      `SELECT email, role, invited_by_user_id, created_at FROM auth_allowlist ORDER BY created_at`,
    )
    .all<AllowlistRow>();
  const userEmails = new Set((users.results ?? []).map((u) => u.email.toLowerCase()));
  return Response.json({
    object: "list",
    members: (users.results ?? []).map((u) => ({
      email: u.email,
      name: u.name,
      role: u.role,
      created_at: new Date(u.created_at).toISOString(),
      last_seen_at: u.last_seen_at ? new Date(u.last_seen_at).toISOString() : null,
      joined: true,
    })),
    pending_invites: (invited.results ?? [])
      .filter((r) => !userEmails.has(r.email.toLowerCase()))
      .map((r) => ({
        email: r.email,
        role: r.role,
        created_at: new Date(r.created_at).toISOString(),
        joined: false,
      })),
  });
}

async function inviteMember(req: Request, env: Env, owner: AuthUser): Promise<Response> {
  let body: { email?: unknown };
  try {
    body = (await req.json()) as { email?: unknown };
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) {
    return httpError.validation("invalid email");
  }
  await env.DB
    .prepare(
      `INSERT INTO auth_allowlist (email, role, invited_by_user_id, created_at)
       VALUES (?1, 'member', ?2, ?3)
       ON CONFLICT(email) DO NOTHING`,
    )
    .bind(email, owner.id, Date.now())
    .run();
  return Response.json({ object: "member", email, role: "member", invited: true });
}

async function removeMember(env: Env, email: string): Promise<Response> {
  const lower = email.toLowerCase();
  // Don't allow removing yourself / the last owner.
  const owners = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner'`)
    .first<{ n: number }>();
  const target = await env.DB
    .prepare(`SELECT id, role FROM users WHERE email = ?1`)
    .bind(lower)
    .first<{ id: string; role: string }>();
  if (target?.role === "owner" && (owners?.n ?? 0) <= 1) {
    return httpError.forbidden("cannot remove the last owner");
  }
  await env.DB.prepare(`DELETE FROM auth_allowlist WHERE email = ?1`).bind(lower).run();
  if (target) {
    await env.DB.prepare(`DELETE FROM auth_sessions WHERE user_id = ?1`).bind(target.id).run();
  }
  return Response.json({ object: "member", email: lower, removed: true });
}
