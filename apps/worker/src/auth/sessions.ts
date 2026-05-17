import type { Env } from "../env";
import { newId } from "../ids";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function base64urlRandom(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CreatedSession {
  rawToken: string;
  expiresAt: number;
}

export async function createSession(
  env: Env,
  userId: string,
  meta?: { userAgent?: string | null; ip?: string | null },
): Promise<CreatedSession> {
  const rawToken = base64urlRandom(32);
  const hash = await sha256Hex(rawToken);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB
    .prepare(
      `INSERT INTO auth_sessions
         (id, user_id, token_sha256, created_at, expires_at, last_seen_at, user_agent, ip)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6, ?7)`,
    )
    .bind(
      `sess_${crypto.randomUUID()}`,
      userId,
      hash,
      now,
      expiresAt,
      meta?.userAgent ?? null,
      meta?.ip ?? null,
    )
    .run();
  return { rawToken, expiresAt };
}

export interface LookupResult {
  userId: string;
  sessionId: string;
  expiresAt: number;
}

export async function lookupSession(env: Env, rawToken: string): Promise<LookupResult | null> {
  if (!rawToken) return null;
  const hash = await sha256Hex(rawToken);
  const row = await env.DB
    .prepare(
      `SELECT id, user_id, expires_at FROM auth_sessions WHERE token_sha256 = ?1`,
    )
    .bind(hash)
    .first<{ id: string; user_id: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;

  // Fire-and-forget last_seen bump.
  env.DB
    .prepare(`UPDATE auth_sessions SET last_seen_at = ?2 WHERE id = ?1`)
    .bind(row.id, Date.now())
    .run()
    .catch(() => {});

  return { userId: row.user_id, sessionId: row.id, expiresAt: row.expires_at };
}

export async function revokeSession(env: Env, rawToken: string): Promise<void> {
  if (!rawToken) return;
  const hash = await sha256Hex(rawToken);
  await env.DB
    .prepare(`DELETE FROM auth_sessions WHERE token_sha256 = ?1`)
    .bind(hash)
    .run();
}

export async function revokeAllSessionsForUser(env: Env, userId: string): Promise<void> {
  await env.DB
    .prepare(`DELETE FROM auth_sessions WHERE user_id = ?1`)
    .bind(userId)
    .run();
}

// Use a plain cookie name (no `__Host-` prefix). The `__Host-` prefix would be
// the security-strictest choice, but Cloudflare's `*.workers.dev` is on the
// Public Suffix List which empirically causes some browsers to silently drop
// `__Host-` cookies. We still pass HttpOnly + Secure + SameSite=Lax for the
// same threat model in practice.
export const SESSION_COOKIE_NAME = "disess";

export function makeSessionCookie(rawToken: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function makeClearCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ].join("; ");
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === SESSION_COOKIE_NAME) {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}
