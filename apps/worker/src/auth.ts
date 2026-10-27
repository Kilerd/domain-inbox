import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";
import { httpError } from "./http";
import { newId } from "./ids";
import { lookupSession, readSessionCookie } from "./auth/sessions";

export interface AuthUser {
  /**
   * Data owner id. In a shared workspace this is the owner's user id, not the
   * signed-in person: mail/domain/rules queries scope on it. Sessions and
   * per-device rows use `user_id`.
   */
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  role: string;
  is_new: boolean;
}

export type AuthResult =
  | { kind: "ok"; user: AuthUser }
  | { kind: "error"; response: Response };

// JWKS cache for Cloudflare Access path (kept for future SSO use).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: `https://${teamDomain}.cloudflareaccess.com`,
      audience: aud,
    });
    return payload;
  } catch {
    return null;
  }
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  workspace_id: string;
  created_at: number;
}

async function loadUser(env: Env, userId: string): Promise<AuthUser | null> {
  const row = await env.DB
    .prepare(
      `SELECT id, email, name, role, COALESCE(workspace_owner_id, id) AS workspace_id,
              created_at
       FROM users WHERE id = ?1`,
    )
    .bind(userId)
    .first<UserRow>();
  if (!row) return null;
  return {
    id: row.workspace_id,
    user_id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    is_new: false,
  };
}

async function provisionFromEmail(
  env: Env,
  email: string,
  name: string | null,
  provider: string,
): Promise<AuthUser | null> {
  const now = Date.now();
  const proposedId = newId.user();
  const owner = await env.DB
    .prepare(`SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1`)
    .first<{ id: string }>();
  const role = owner ? "member" : "owner";
  const workspaceId = owner?.id ?? proposedId;
  const row = await env.DB
    .prepare(
      `INSERT INTO users
         (id, email, name, auth_provider, role, workspace_owner_id, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(email) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         workspace_owner_id = COALESCE(users.workspace_owner_id, excluded.workspace_owner_id)
       RETURNING id, email, name, role,
                 COALESCE(workspace_owner_id, id) AS workspace_id,
                 created_at`,
    )
    .bind(proposedId, email.toLowerCase(), name, provider, role, workspaceId, now)
    .first<UserRow>();
  if (!row) return null;
  return {
    id: row.workspace_id,
    user_id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    is_new: row.created_at === now,
  };
}

/**
 * Three-tier authentication:
 *   1. `__Host-disess` cookie  → magic-link session lookup
 *   2. Dev backdoor             → only when DEV_USER_TOKEN is set AND
 *                                 the request carries `X-Dev-Auth: <that token>`
 *   3. Cloudflare Access JWT    → only when ACCESS_TEAM_DOMAIN+AUD configured
 */
export async function authenticate(req: Request, env: Env): Promise<AuthResult> {
  // (1) Cookie session
  const cookieToken = readSessionCookie(req);
  if (cookieToken) {
    const found = await lookupSession(env, cookieToken);
    if (found) {
      const user = await loadUser(env, found.userId);
      if (user) return { kind: "ok", user };
    }
  }

  // (2) Dev backdoor (gated by header so public dev origin still requires login).
  if (
    env.ENV === "dev" &&
    env.DEV_USER_TOKEN &&
    env.DEV_USER_EMAIL &&
    req.headers.get("X-Dev-Auth") === env.DEV_USER_TOKEN
  ) {
    const user = await provisionFromEmail(
      env,
      env.DEV_USER_EMAIL,
      env.DEV_USER_NAME ?? null,
      "dev_backdoor",
    );
    if (user) return { kind: "ok", user };
  }

  // (3) Cloudflare Access JWT (optional, future SSO)
  const accessJwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (accessJwt && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const claims = await verifyAccessJwt(accessJwt, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    if (!claims) {
      return { kind: "error", response: httpError.unauthorized("Access JWT failed verification") };
    }
    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
    const name = typeof claims.name === "string" ? claims.name : null;
    if (email) {
      const user = await provisionFromEmail(env, email, name, "cf_access");
      if (user) return { kind: "ok", user };
    }
  }

  return {
    kind: "error",
    response: httpError.missingApiKey("not signed in"),
  };
}
