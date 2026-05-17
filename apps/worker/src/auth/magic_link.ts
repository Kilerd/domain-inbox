import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import type { Env } from "../env";
import { log } from "../utils/log";

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_WINDOW_S = 3600;
const RATE_LIMIT_MAX = 5;

function base64urlRandom(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isAllowed(env: Env, email: string): Promise<boolean> {
  const row = await env.DB
    .prepare(`SELECT email FROM auth_allowlist WHERE email = ?1`)
    .bind(email.toLowerCase())
    .first<{ email: string }>();
  if (row) return true;
  // Bootstrap: first ever login auto-promotes to owner.
  const userCount = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner'`)
    .first<{ n: number }>();
  return (userCount?.n ?? 0) === 0;
}

export async function issueLoginToken(env: Env, emailRaw: string): Promise<string> {
  const email = emailRaw.trim().toLowerCase();

  // Per-email rate limit. KV counter keyed by email + UTC hour bucket.
  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_S);
  const rlKey = `login_rl:${email}:${bucket}`;
  const seen = parseInt((await env.KV.get(rlKey)) ?? "0", 10);
  if (seen >= RATE_LIMIT_MAX) {
    throw new Error("rate_limited");
  }
  await env.KV.put(rlKey, String(seen + 1), { expirationTtl: RATE_LIMIT_WINDOW_S });

  const rawToken = base64urlRandom(32);
  const hash = await sha256Hex(rawToken);
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO auth_login_tokens (token_sha256, email, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(hash, email, now, now + LOGIN_TOKEN_TTL_MS)
    .run();
  return rawToken;
}

export interface ConsumedToken {
  email: string;
}

export async function consumeLoginToken(env: Env, rawToken: string): Promise<ConsumedToken | null> {
  const hash = await sha256Hex(rawToken);
  const row = await env.DB
    .prepare(
      `SELECT email, expires_at, consumed_at
       FROM auth_login_tokens WHERE token_sha256 = ?1`,
    )
    .bind(hash)
    .first<{ email: string; expires_at: number; consumed_at: number | null }>();
  if (!row) return null;
  if (row.consumed_at != null) return null;
  if (row.expires_at < Date.now()) return null;
  await env.DB
    .prepare(`UPDATE auth_login_tokens SET consumed_at = ?2 WHERE token_sha256 = ?1`)
    .bind(hash, Date.now())
    .run();
  return { email: row.email };
}

export async function sendLoginEmail(env: Env, email: string, link: string): Promise<void> {
  if (!env.EMAIL) {
    throw new Error("EMAIL binding not configured");
  }
  if (!env.PRIMARY_DOMAIN) {
    throw new Error("PRIMARY_DOMAIN env var not configured");
  }
  const from = `auth@${env.PRIMARY_DOMAIN}`;
  const mime = createMimeMessage();
  mime.setSender({ name: "Domain Inbox", addr: from });
  mime.setTo(email);
  mime.setSubject("Sign in to Domain Inbox");
  mime.addMessage({
    contentType: "text/plain",
    data: [
      "Click the link below to sign in to Domain Inbox.",
      "",
      link,
      "",
      "The link expires in 15 minutes and can only be used once.",
      "",
      "If you didn't request this, you can safely ignore the email.",
    ].join("\n"),
  });
  mime.addMessage({
    contentType: "text/html",
    data: `
<!doctype html>
<p>Click the link below to sign in to Domain Inbox.</p>
<p><a href="${link}" style="font-size:15px;padding:10px 16px;background:#2563eb;color:white;border-radius:6px;text-decoration:none;display:inline-block;">Sign in</a></p>
<p style="font-size:12px;color:#666">Or copy this URL into your browser:<br><code>${link}</code></p>
<p style="font-size:12px;color:#666">The link expires in 15 minutes and can only be used once.</p>
<p style="font-size:12px;color:#666">If you didn't request this, you can safely ignore the email.</p>
`,
  });

  const msg = new EmailMessage(from, email, mime.asRaw());
  await env.EMAIL.send(msg);
  log.info("auth.login_email_sent", { email });
}
