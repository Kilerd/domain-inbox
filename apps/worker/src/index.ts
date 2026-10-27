import { handleApiKeys } from "./api/apikeys";
import { authenticateApiKey } from "./api/apikey_auth";
import { tryAuthRoutes } from "./api/auth";
import { handleDomains } from "./api/domains";
import { handleMembers } from "./api/members";
import { handleRules } from "./api/rules";
import {
  cancelOutboundMessage,
  getOutboundMessage,
  getOutboundMessageEvents,
  handleEmailBatch,
  handleEmailSend,
  listOutboundMessages,
  patchOutboundMessage,
  processScheduledSends,
  reapStuckSends,
} from "./api/emails";
import { releaseExpiredIdempotencyKeys } from "./api/idempotency";
import { handleImgProxy } from "./api/img_proxy";
import { handleInbox } from "./api/inbox";
import { handlePush } from "./api/push";
import { handleReceiving } from "./api/receiving";
import { handleReports } from "./api/reports";
import { handleSuppressions } from "./api/suppressions";
import { handleTemplates } from "./api/templates";
import { handleClickRedirect, handleOpenPixel } from "./api/tracking";
import { handleVacation } from "./api/vacation";
import { handleWebhooks } from "./api/webhooks";
import { authenticate } from "./auth";
import { handleInboundEmail } from "./email/ingest";
import { backfillSearchIndex } from "./email/search_index";
import type { Env } from "./env";
import { httpError } from "./http";
import { log } from "./utils/log";
import { retryPendingWebhookDeliveries, svixSign } from "./webhooks/dispatch";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(url, req, env, ctx);
    }
    // Tracking endpoints live under a short prefix so the URLs that get
    // embedded in outbound emails stay compact.
    if (url.pathname.startsWith("/t/o/") && req.method === "GET") {
      return handleOpenPixel(url, req, env, ctx);
    }
    if (url.pathname.startsWith("/t/c/") && req.method === "GET") {
      return handleClickRedirect(url, req, env, ctx);
    }

    return env.ASSETS.fetch(req);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleInboundEmail(message, env, ctx);
  },

  // Cron sweep (see wrangler.toml [triggers]): due scheduled sends, webhook
  // delivery retries, and releasing Idempotency-Keys past their 24 h window.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    log.info("cron.start", { cron: controller.cron, scheduled_time: controller.scheduledTime });
    // Every task is isolated: one failure must not take the rest of the
    // sweep down (and the label makes the failing task visible in logs).
    const run = (task: string, p: Promise<unknown>) =>
      p.catch((err) => log.warn("cron.task_failed", { task, error: String(err) }));
    ctx.waitUntil(run("scheduled-sends", processScheduledSends(env, ctx)));
    ctx.waitUntil(run("webhook-retries", retryPendingWebhookDeliveries(env)));
    ctx.waitUntil(run("idempotency-sweep", releaseExpiredIdempotencyKeys(env)));
    // A send that never recorded an outcome (client disconnect, isolate
    // eviction mid-send) stays 'sending' forever; mark it failed so the
    // outbox/API can retry it and the activity view stops lying.
    ctx.waitUntil(run("stuck-sends", reapStuckSends(env)));
    // Index old mail a small batch at a time; no-ops once caught up.
    ctx.waitUntil(run("search-backfill", backfillSearchIndex(env, 20)));
  },
} satisfies ExportedHandler<Env>;

// Top-level API request dispatch. Three tiers, ordered by auth requirement:
//
//   1. tryPublic        — health checks, image proxy, dev-only fixtures
//   2. tryBearer        — Resend-compatible endpoints (Authorization: Bearer re_…)
//   3. authenticate()   — Cloudflare Access JWT for Web/SPA-driven routes
//
// Each handler returns null when the path doesn't match, so the dispatcher
// can fall through cleanly to the next tier without an exception-based flow.
async function handleApi(
  url: URL,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const publicRes = await tryPublic(url, req, env);
  if (publicRes) return publicRes;

  // Magic-link auth endpoints are public (anyone can request a sign-in link;
  // the backend's allowlist + send_email gate ensures only invited emails
  // actually receive one).
  const authRouteRes = await tryAuthRoutes(url, req, env, ctx);
  if (authRouteRes) return authRouteRes;

  const bearerRes = await tryBearer(url, req, env, ctx);
  if (bearerRes) return bearerRes;

  const auth = await authenticate(req, env);
  if (auth.kind === "error") return auth.response;

  const userRes = await tryUser(url, req, env, auth.user, ctx);
  if (userRes) return userRes;

  return httpError.notFound(`route ${url.pathname} does not exist`);
}

async function tryPublic(url: URL, req: Request, env: Env): Promise<Response | null> {
  if (url.pathname === "/api/_health") {
    return Response.json({ ok: true, service: "domain-inbox", env: env.ENV, ts: Date.now() });
  }
  if (url.pathname === "/api/img-proxy") {
    return handleImgProxy(url, env);
  }
  // Test fixtures (`/_test/*`, `/_debug/*`) are only for development. They
  // used to gate on ENV === "dev" alone — but the live deployment also runs
  // with ENV=dev, which left an unauthenticated send/inject surface open to
  // the internet. Require the dev backdoor secret as well: on a deployment
  // without DEV_USER_TOKEN these routes simply do not exist.
  if (
    env.ENV === "dev" &&
    env.DEV_USER_TOKEN &&
    req.headers.get("X-Dev-Auth") === env.DEV_USER_TOKEN
  ) {
    return tryDevFixtures(url, req, env);
  }
  return null;
}

async function tryDevFixtures(url: URL, req: Request, env: Env): Promise<Response | null> {
  if (url.pathname === "/api/_debug/db") {
    return handleDebugDb(env);
  }
  if (url.pathname === "/api/_test/inject-email" && req.method === "POST") {
    return handleInjectEmail(req, env);
  }
  if (url.pathname === "/api/_test/sign" && req.method === "POST") {
    const { secret, msg_id, timestamp, body } = (await req.json()) as {
      secret: string;
      msg_id: string;
      timestamp: number;
      body: string;
    };
    const sig = await svixSign(secret, msg_id, timestamp, body);
    return Response.json({ signature: sig });
  }
  if (url.pathname === "/api/_test/verp-probe" && req.method === "POST") {
    return handleVerpProbe(req, env);
  }
  if (url.pathname === "/api/_test/webhook-sink" && req.method === "POST") {
    return handleWebhookSink(req, env);
  }
  if (url.pathname === "/api/_test/webhook-sink" && req.method === "GET") {
    const stored = await env.KV.get("test:webhook-sink:last", "text");
    return stored
      ? new Response(stored, { headers: { "content-type": "application/json" } })
      : Response.json({ empty: true });
  }
  return null;
}

async function tryBearer(
  url: URL,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // Service tokens: an API key with `inbox.read` can pull received mail for
  // every domain the owner has, without a browser session. Read-only on
  // purpose — writes (compose, flags, alias edits) still require the SPA's
  // session auth, so a leaked automation token can't send or delete anything.
  //
  // Only take this path when a bearer token was actually presented: the SPA
  // calls the same /api/inbox/* routes with cookies and no Authorization
  // header, and must keep falling through to the session verifier.
  if (url.pathname === "/api/inbox" || url.pathname.startsWith("/api/inbox/")) {
    const authorization = req.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return null;

    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    if (req.method !== "GET") {
      return httpError.forbidden(
        "API keys are read-only for the inbox; use a browser session to modify mail",
      );
    }
    if (!k.auth.scopes.includes("inbox.read")) {
      return httpError.forbidden("API key is missing the inbox.read scope");
    }
    if (k.auth.domain_scope && k.auth.domain_scope.length > 0) {
      return httpError.forbidden(
        "inbox.read requires an account-wide API key (domain_scope must be empty)",
      );
    }
    return handleInbox(
      url,
      req,
      env,
      { id: k.auth.user_id, email: "", name: null, is_new: false },
      ctx,
    );
  }

  // Domain metadata is readable with a `domains.read` key (the default scope
  // set includes it). Only GET is exposed; POST/DELETE/verify stay on the
  // browser session. As above, a cookie-only SPA request must fall through.
  if (
    (url.pathname === "/api/v1/domains" || url.pathname.startsWith("/api/v1/domains/"))
  ) {
    const authorization = req.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return null;

    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    if (req.method !== "GET") {
      return httpError.forbidden(
        "API keys are read-only for domains; use a browser session to modify them",
      );
    }
    if (!k.auth.scopes.includes("domains.read")) {
      return httpError.forbidden("API key is missing the domains.read scope");
    }
    if (k.auth.domain_scope && k.auth.domain_scope.length > 0) {
      return httpError.forbidden(
        "domains.read requires an account-wide API key (domain_scope must be empty)",
      );
    }
    return handleDomains(
      url,
      req,
      env,
      { id: k.auth.user_id, email: "", name: null, is_new: false },
      ctx,
    );
  }

  // Resend-compatible receiving API. Match before the generic
  // `/api/v1/emails/:id` route so "receiving" is never treated as an id.
  if (
    url.pathname === "/api/v1/emails/receiving" ||
    url.pathname.startsWith("/api/v1/emails/receiving/")
  ) {
    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    return handleReceiving(url, req, env, k.auth);
  }

  // All Resend-style endpoints are gated on the bearer-token auth path.
  // Match the route first; only run auth when we're going to actually serve.
  if (url.pathname === "/api/v1/emails" && req.method === "POST") {
    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    return handleEmailSend(req, env, k.auth, ctx);
  }
  if (url.pathname === "/api/v1/emails" && req.method === "GET") {
    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    return listOutboundMessages(url, env, k.auth);
  }
  if (url.pathname === "/api/v1/emails/batch" && req.method === "POST") {
    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    return handleEmailBatch(req, env, k.auth);
  }
  const eventsMatch = url.pathname.match(/^\/api\/v1\/emails\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "GET") {
    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    return getOutboundMessageEvents(env, k.auth, eventsMatch[1]!);
  }
  const cancelMatch = url.pathname.match(/^\/api\/v1\/emails\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    return cancelOutboundMessage(env, k.auth, cancelMatch[1]!, ctx);
  }
  const emailGet = url.pathname.match(/^\/api\/v1\/emails\/([^/]+)$/);
  if (emailGet && (req.method === "GET" || req.method === "PATCH")) {
    const k = await authenticateApiKey(req, env);
    if (k.kind === "error") return k.response;
    return req.method === "GET"
      ? getOutboundMessage(env, k.auth, emailGet[1]!)
      : patchOutboundMessage(req, env, k.auth, emailGet[1]!, ctx);
  }
  return null;
}

async function tryUser(
  url: URL,
  req: Request,
  env: Env,
  user: { id: string; email: string; name: string | null; is_new: boolean },
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname === "/api/me") {
    return Response.json({
      id: user.id,
      email: user.email,
      name: user.name,
      is_new: user.is_new,
    });
  }
  if (url.pathname.startsWith("/api/inbox/")) {
    return handleInbox(url, req, env, user, ctx);
  }
  if (url.pathname === "/api/v1/domains" || url.pathname.startsWith("/api/v1/domains/")) {
    return handleDomains(url, req, env, user, ctx);
  }
  if (url.pathname === "/api/v1/api-keys" || url.pathname.startsWith("/api/v1/api-keys/")) {
    return handleApiKeys(url, req, env, user);
  }

  if (url.pathname === "/api/v1/members" || url.pathname.startsWith("/api/v1/members/")) {
    return handleMembers(url, req, env, user);
  }
  if (url.pathname === "/api/v1/webhooks" || url.pathname.startsWith("/api/v1/webhooks/")) {
    return handleWebhooks(url, req, env, user);
  }
  if (url.pathname === "/api/v1/rules" || url.pathname.startsWith("/api/v1/rules/")) {
    return handleRules(url, req, env, user);
  }
  if (url.pathname === "/api/v1/vacation") {
    return handleVacation(url, req, env, user);
  }
  if (url.pathname === "/api/v1/reports" || url.pathname.startsWith("/api/v1/reports/")) {
    return handleReports(url, req, env, user);
  }
  if (url.pathname === "/api/v1/push" || url.pathname.startsWith("/api/v1/push/")) {
    return handlePush(url, req, env, user);
  }
  if (
    url.pathname === "/api/v1/suppressions" ||
    url.pathname.startsWith("/api/v1/suppressions/")
  ) {
    return handleSuppressions(url, req, env, user);
  }
  if (
    url.pathname === "/api/v1/templates" ||
    url.pathname.startsWith("/api/v1/templates/")
  ) {
    return handleTemplates(url, req, env, user);
  }
  return null;
}

async function handleVerpProbe(req: Request, env: Env): Promise<Response> {
  const { EmailMessage } = await import("cloudflare:email");
  const { createMimeMessage } = await import("mimetext");
  if (!env.EMAIL) return Response.json({ ok: false, error: "no EMAIL binding" }, { status: 503 });
  let body: { from?: string; envelope_from?: string; to?: string; subject?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const domain = env.PRIMARY_DOMAIN ?? "example.com";
  const headerFrom = body.from ?? `hello@${domain}`;
  const envelopeFrom = body.envelope_from ?? `bounce+probe-test@cf-bounce.${domain}`;
  const to = body.to ?? `nonexistent-mailbox-probe@${domain}`;
  const subject = body.subject ?? "VERP feasibility probe";
  const mime = createMimeMessage();
  mime.setSender({ addr: headerFrom });
  mime.setTo(to);
  mime.setSubject(subject);
  mime.setHeader("Message-ID", `<verp-probe-${crypto.randomUUID()}@${domain}>`);
  mime.addMessage({ contentType: "text/plain", data: "VERP probe — please ignore." });
  const raw = mime.asRaw();

  try {
    const msg = new EmailMessage(envelopeFrom, to, raw);
    await env.EMAIL.send(msg);
    return Response.json({
      ok: true,
      sent_at: Date.now(),
      header_from: headerFrom,
      envelope_from: envelopeFrom,
      to,
      raw_bytes: raw.length,
      note: "send succeeded; watch wrangler tail + inbox for the resulting DSN to confirm cf-bounce returned the message",
    });
  } catch (e) {
    return Response.json({
      ok: false,
      error: String((e as Error)?.message ?? e),
      header_from: headerFrom,
      envelope_from: envelopeFrom,
      to,
    }, { status: 500 });
  }
}

async function handleWebhookSink(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
  const record = { received_at: Date.now(), headers, body };
  await env.KV.put("test:webhook-sink:last", JSON.stringify(record), {
    expirationTtl: 3600,
  });
  return Response.json({ ok: true });
}

async function handleInjectEmail(req: Request, env: Env): Promise<Response> {
  const from = (req.headers.get("X-Test-From") ?? "tester@example.com").toLowerCase();
  const to = (req.headers.get("X-Test-To") ?? `anything@${env.PRIMARY_DOMAIN ?? "example.com"}`).toLowerCase();
  const rawBytes = new Uint8Array(await req.arrayBuffer());
  if (rawBytes.byteLength === 0) {
    return httpError.badRequest("request body must be raw .eml bytes");
  }

  const rawStream = new Response(rawBytes).body!;
  const pending: Promise<unknown>[] = [];
  const ctxLike = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const fakeMessage = {
    from,
    to,
    raw: rawStream,
    rawSize: rawBytes.byteLength,
    headers: new Headers(),
    forward: async () => { throw new Error("forward not supported in inject-email"); },
    reply: async () => { throw new Error("reply not supported in inject-email"); },
    setReject: (reason: string) => { console.log(JSON.stringify({ event: "inject.reject", reason })); },
  } as unknown as ForwardableEmailMessage;

  try {
    await handleInboundEmail(fakeMessage, env, ctxLike);
    // The fixture runs the same post-processing as production, including
    // waitUntil work (vacation replies, webhook fan-out).
    await Promise.allSettled(pending);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

async function handleDebugDb(env: Env): Promise<Response> {
  try {
    const ping = await env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    const tables = await env.DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all<{ name: string }>();
    const tableCounts: Record<string, number> = {};
    for (const row of tables.results) {
      const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${row.name}"`).first<{ n: number }>();
      tableCounts[row.name] = c?.n ?? -1;
    }
    return Response.json({ ok: true, ping: ping?.one === 1, tables: tableCounts });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
