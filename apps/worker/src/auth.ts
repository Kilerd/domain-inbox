import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";
import { httpError } from "./http";
import { newId } from "./ids";
import { lookupSession, readSessionCookie } from "./auth/sessions";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
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
  created_at: number;
}

async function loadUser(env: Env, userId: string): Promise<AuthUser | null> {
  const row = await env.DB
    .prepare(`SELECT id, email, name, created_at FROM users WHERE id = ?1`)
    .bind(userId)
    .first<UserRow>();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, is_new: false };
}

async function provisionFromEmail(
  env: Env,
  email: string,
  name: string | null,
  provider: string,
): Promise<AuthUser | null> {
  const now = Date.now();
  const proposedId = newId.user();
  const row = await env.DB
    .prepare(
      `INSERT INTO users (id, email, name, auth_provider, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at
       RETURNING id, email, name, created_at`,
    )
    .bind(proposedId, email.toLowerCase(), name, provider, now)
    .first<UserRow>();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
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
