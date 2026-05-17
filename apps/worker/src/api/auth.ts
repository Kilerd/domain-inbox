import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";
import { log } from "../utils/log";
import {
  consumeLoginToken,
  isAllowed,
  issueLoginToken,
  sendLoginEmail,
} from "../auth/magic_link";
import {
  createSession,
  makeClearCookie,
  makeSessionCookie,
  readSessionCookie,
  revokeSession,
} from "../auth/sessions";

export async function tryAuthRoutes(
  url: URL,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    return postLogin(req, env, ctx);
  }
  if (url.pathname === "/api/auth/callback" && req.method === "GET") {
    return getCallback(url, req, env);
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    return postLogout(req, env);
  }
  return null;
}

async function postLogin(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // Always return success — never reveal whether the email is on the allowlist.
  // Defer email send + allowlist check via waitUntil so timing is uniform.
  ctx.waitUntil(
    (async () => {
      try {
        const allowed = await isAllowed(env, email);
        if (!allowed) {
          log.info("auth.login_blocked_not_invited", { email });
          return;
        }
        const token = await issueLoginToken(env, email);
        const base = env.APP_BASE_URL ?? new URL(req.url).origin;
        const link = `${base}/api/auth/callback?token=${encodeURIComponent(token)}`;
        await sendLoginEmail(env, email, link);
      } catch (err) {
        log.warn("auth.login_send_failed", { email, error: String(err) });
      }
    })(),
  );

  return Response.json({ ok: true });
}

async function getCallback(url: URL, req: Request, env: Env): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response(loginErrorHtml("Missing sign-in token."), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const consumed = await consumeLoginToken(env, token);
  if (!consumed) {
    return new Response(loginErrorHtml("Sign-in link expired or already used."), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Check allowlist OR auto-bootstrap owner if no users exist yet.
  const allowed = await isAllowed(env, consumed.email);
  if (!allowed) {
    return new Response(loginErrorHtml(`${consumed.email} is not invited.`), {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Upsert user. First ever owner-less user becomes the owner.
  const now = Date.now();
  const userIdProposed = newId.user();
  const ownerRow = await env.DB
    .prepare(`SELECT id FROM users WHERE role = 'owner' LIMIT 1`)
    .first<{ id: string }>();
  const role = ownerRow ? "member" : "owner";

  const inserted = await env.DB
    .prepare(
      `INSERT INTO users (id, email, name, auth_provider, role, created_at, last_seen_at)
       VALUES (?1, ?2, NULL, 'magic_link', ?3, ?4, ?4)
       ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at
       RETURNING id, role`,
    )
    .bind(userIdProposed, consumed.email, role, now)
    .first<{ id: string; role: string }>();
  if (!inserted) {
    return new Response(loginErrorHtml("Failed to provision user."), { status: 500 });
  }

  // If we just bootstrapped the very first owner, also seed allowlist.
  if (role === "owner" && !ownerRow) {
    await env.DB
      .prepare(
        `INSERT INTO auth_allowlist (email, role, invited_by_user_id, created_at)
         VALUES (?1, 'owner', ?2, ?3)
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(consumed.email, inserted.id, now)
      .run();
    log.info("auth.owner_bootstrapped", { email: consumed.email });
  }

  // Mint a session cookie + redirect to app root.
  const ua = req.headers.get("user-agent");
  const ip = req.headers.get("cf-connecting-ip");
  const sess = await createSession(env, inserted.id, { userAgent: ua, ip });
  const cookie = makeSessionCookie(sess.rawToken, sess.expiresAt);
  const dest = env.APP_BASE_URL ?? new URL(req.url).origin;

  log.info("auth.callback_success", {
    email: consumed.email,
    user_id: inserted.id,
    role,
    ua: ua?.slice(0, 80) ?? null,
    cookie_length: cookie.length,
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: `${dest}/`,
      "set-cookie": cookie,
    },
  });
}

async function postLogout(req: Request, env: Env): Promise<Response> {
  const token = readSessionCookie(req);
  if (token) await revokeSession(env, token);
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": makeClearCookie() },
  });
}

function loginErrorHtml(message: string): string {
  return `<!doctype html><html><head><meta charset=utf-8><title>Sign-in failed</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18181b;background:#fafafa;padding:48px;text-align:center}
@media (prefers-color-scheme:dark){body{color:#e4e4e7;background:#0a0a0a}}
.card{max-width:420px;margin:0 auto;padding:24px;border-radius:8px;background:white;border:1px solid #e4e4e7}
@media (prefers-color-scheme:dark){.card{background:#18181b;border-color:#27272a}}
h1{font-size:18px;margin:0 0 8px}p{color:#666;margin:0 0 16px}
a{color:#2563eb;text-decoration:none}</style></head>
<body><div class="card"><h1>Sign-in failed</h1><p>${message}</p><a href="/">← Back to sign-in</a></div></body></html>`;
}
