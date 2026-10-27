# domain-inbox

Self-hosted multi-domain email on a single Cloudflare Worker — and a drop-in
[Resend](https://resend.com) alternative.

Receive mail on any address across any number of your domains, send
transactional email through Resend's exact HTTP API, manage everything from one
web UI. A free Cloudflare account is enough to get started.

---

## What you get

- **A real inbox per domain.** Anything sent to `*@your-domain.com` lands in
  the web UI within ~2 seconds, attachments included, threaded by `In-Reply-To`
  / `References` headers.
- **A Resend-compatible send API.** Point the official Resend SDK at your
  Worker via one env var — same idempotency, batch, GET/cancel, Svix-signed
  webhooks. Verified against the real Resend Node SDK.
- **Shared team inbox.** Invite teammates from Settings → Members; every member
  sees the same domains, threads, rules, templates and send quota. Member
  management stays owner-only, while mail actions and replies are shared.
- **Inbound automation.** Rules match sender/recipient/subject/attachment and
  apply star/archive/trash/spam/read. A per-owner vacation responder replies
  once per sender every three days, with loop/automation/suppression guards.
- **Deliverability reports.** DMARC aggregate (XML) and TLS-RPT (JSON) reports
  arriving at your domains are parsed into a dashboard — point `rua=` and the
  `_smtp._tls` record at the inbox and the Reports screen fills itself.
- **Installable PWA with Web Push.** The SPA ships a manifest and service
  worker; install it from the browser and press the bell in the header to get
  a system notification for new mail on every subscribed device (RFC 8291
  encryption, VAPID-signed). Push is disabled until the three `VAPID_*`
  secrets are set.
- **All on Cloudflare.** D1 for metadata, R2 for raw MIME, KV for fast token
  lookup. No external services.

## Drop-in for existing Resend users

No SDK swap, no code changes — one env var:

```ts
import { Resend } from "resend";

process.env.RESEND_BASE_URL = "https://domain-inbox-dev.<your-subdomain>.workers.dev/api/v1";
const resend = new Resend(process.env.RESEND_API_KEY); // re_live_xxx minted in the SPA

await resend.emails.send({
  from: "hello@your-domain.com",
  to:   ["someone@example.com"],
  subject: "Hi from my own infra",
  html: "<p>Sent through Cloudflare Email Sending.</p>",
});
```

| Resend feature             | Status |
| -------------------------- | :----: |
| `POST /emails` send        |   ✅   |
| Batch send                 |   ✅   |
| `Idempotency-Key` (24h)    |   ✅   |
| `GET /emails/:id`          |   ✅   |
| Schedule + `PATCH` + cancel|   ✅   |
| Webhooks (Svix signature)  |   ✅   |
| Tags, headers, attachments |   ✅   |

`Idempotency-Key` follows Resend: for 24 h after the first request, a retry
with the same key and payload returns the original id without sending again,
and the same key with a different payload is rejected with
`409 invalid_idempotent_request`. After 24 h the key can be reused, and a request
that uses it is sent as a new email.

Compatibility is end-to-end verified by `scripts/resend-compat-smoke.mjs`
(runs the unmodified `resend` package against the Worker) and
`scripts/webhook-signature-check.mjs` (cross-checks signatures with the
official Svix SDK).

### Test mode

Tick *Test mode* when creating an API key (or send `"test_mode": true`); the
token starts with `re_test_`. `POST /api/v1/emails` then records the outbound
row, event and webhooks exactly like a real send, but never calls the provider
or copies the mail into the inbox. Use `delivered@…`, `bounced@…` or
`complained@…` as recipients to simulate those outcomes. Test sends do not
consume the daily send quota; scheduled sends are rejected for test keys.

### Receiving API

Inbound mail is readable by programs with an `emails.read` key (the default
key scopes include it). Domain-scoped keys only see their own domains:

```bash
TOKEN=re_live_xxx
BASE=https://domain-inbox.<your-subdomain>.workers.dev

# Newest first; filters: from, to, subject, created_after/before, cursor, limit
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/emails/receiving?limit=20&subject=invoice"

# Parsed text/html, headers and attachment metadata
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/emails/receiving/<message_id>"
# Original MIME
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/emails/receiving/<message_id>/raw" -o message.eml
# Attachment bytes
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/emails/receiving/<message_id>/attachments/<attachment_id>" -o file.pdf
```

The `email.received` webhook payload carries `email_id`, `thread_id`, `from`,
`to` and `subject`; pass the `email_id` to the detail endpoint.

### Open & click tracking

Each sending domain has two defaults, `open_tracking` and `click_tracking`
(columns on the `domains` table). A per-request `tracking` field on
`POST /api/v1/emails` overrides them for that one message; omit a key to
fall back to the domain default:

```bash
curl -X POST "https://domain-inbox.<your-subdomain>.workers.dev/api/v1/emails" \
  -H "Authorization: Bearer re_live_xxx" -H "Content-Type: application/json" \
  -d '{
    "from": "auth@your-domain.com",
    "to": ["someone@example.com"],
    "subject": "Reset your password",
    "html": "<a href=\"https://app.example.com/reset?t=…\">Reset</a>",
    "tracking": {"opens": false, "clicks": false}
  }'
```

`tracking` is a domain-inbox extension: the official Resend SDK only
forwards fields it knows and drops it, so SDK users rely on the domain
default and the per-link rules below.

- **New domains have click tracking off** (`click_tracking = 0`); open
  tracking stays on. Click tracking swaps each link for a
  `/t/c/<token>` redirect and keeps the original URL in KV (90 days),
  `email.clicked` events and webhook payloads. That is a bad place for
  one-time secrets, so opt in deliberately: per request with
  `"tracking": {"clicks": true}`, or per domain with
  `UPDATE domains SET click_tracking = 1 WHERE domain = '…'`.
  Domains created before this default changed keep the setting they have.
- **Some links are never rewritten**, even with click tracking on:
  - links whose `href` contains a fragment (`#…`, e.g.
    `https://app.example.com/verify#t=…`) — the fragment is how a sender
    keeps a secret in the browser, so the link is left as is;
  - links on an `<a>` carrying `data-no-track` or `data-pm-no-track`
    (any value, e.g. `<a data-no-track href="…">`) — use this for
    verification, reset, magic-link and invite links;
  - `mailto:`, `tel:`, relative and in-page anchor links.

### Service tokens (read-only inbox API)

For automation that needs to pull received mail (ops scripts, cron jobs, CI
probes), create a **service token** in *Settings → API Keys* by ticking
*Service token — read-only inbox*. It is a normal `re_live_…` API key with the
`inbox.read` scope and no domain restriction, so it covers every domain you
own:

```bash
TOKEN=re_live_xxx
BASE=https://domain-inbox.<your-subdomain>.workers.dev

# Threads, newest first (any SPA view: inbox, unread, archived, …)
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/inbox/threads?view=inbox&limit=20"
# One conversation, full message metadata
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/inbox/threads/<thread_id>/messages"
# Rendered body of one message
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/inbox/messages/<message_id>/body"
# Attachment bytes
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/inbox/attachments/<attachment_id>" -o file.pdf
# Domains / aliases and the live SSE feed
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/inbox/domains"
curl -N -H "Authorization: Bearer $TOKEN" "$BASE/api/inbox/stream"
```

`inbox.read` is **read-only**: every GET under `/api/inbox/*` works, but
`POST`/`PATCH`/`DELETE` (compose, mark-read, flags, alias edits) return `403`
and still require a browser session. Keys with a non-empty `domain_scope` are
rejected for inbox reads — a service token is deliberately account-wide.
Revoke it like any other key; cached auth entries expire within 5 minutes.

Default keys (including the sending keys the SPA creates) also carry
`domains.read`: `GET /api/v1/domains` and `/api/v1/domains/:id` accept the same
bearer token for DNS/verification metadata. Create, verify and delete still
require a browser session, and a scoped key cannot use the bearer form.

## Deploy

The active deployment is `domain-inbox-dev`. Both the default deploy command
and `--env dev` target that Worker and its existing storage. The empty
`domain-inbox` Worker and its separate storage have been retired.

First boot is fail-closed: set `OWNER_EMAIL` (or seed an `auth_allowlist` row)
before exposing a fresh deployment. The old “first login becomes owner” shortcut
is gone. `SEND_DAILY_LIMIT` (default 1000) caps outbound per owner per UTC day;
requests over the cap get `429 rate_limit_exceeded`.

Deploying is a short `wrangler` session: create D1 / R2 / KV, fill the
`<placeholder>` ids in `apps/worker/wrangler.toml`, build the SPA, apply
migrations, deploy. Two steps Cloudflare can't automate: enable
**Email Routing** on your domain, and apply **D1 migrations**.

(The Deploy-to-Cloudflare one-click button doesn't work for this repo —
pnpm monorepo with the config in `apps/worker/`, and the Email Sending
binding can't be auto-provisioned.)

See [DEPLOY.md](./DEPLOY.md) for the full walkthrough.

## How it works

One Worker, four entry points:

```
Inbound mail   ─►  email() handler      ─►  postal-mime  ─►  D1 + R2  ─►  SSE push to SPA
HTTP + SPA     ─►  fetch() handler      ─►  /api/v1/* (Resend-compatible) + inbox routes
Outbound send  ─►  env.EMAIL.send()     ─►  Svix-signed webhook fan-out
Cron (2 min)   ─►  scheduled() handler  ─►  due scheduled sends + webhook delivery retries
```

The web UI and the public API share the same Worker; the SPA is served from
the `ASSETS` binding, and `/api/*` is routed through the Worker first so the
SPA fallback never intercepts API responses.

Auth is two stacks side by side: **Cloudflare Access** JWT for the web UI,
**`re_live_xxx` bearer tokens** (hashed in D1, KV-cached) for the API.

## Project layout

```
apps/
  worker/             single Cloudflare Worker
    src/api/             Resend-compatible + inbox routes
    src/email/           ingest → parse → thread pipeline
    src/webhooks/        Svix-signed fan-out dispatcher
    src/auth/            magic-link + Cloudflare Access JWT verifier
    migrations/          D1 schema
  web/                Vite + React + TanStack + Tailwind SPA
scripts/              smoke tests: Resend SDK compat, webhook signature parity
```

## Local development

```bash
pnpm install

# Worker only (runs the `dev` env) — wrangler dev on http://127.0.0.1:8787
pnpm --filter @domain-inbox/worker run dev

# SPA against a remote dev worker
VITE_API_PROXY_TARGET=https://domain-inbox-dev.<your-subdomain>.workers.dev \
  pnpm --filter @domain-inbox/web run dev

# Tests + typecheck
pnpm --filter @domain-inbox/worker run test
pnpm --filter @domain-inbox/worker run typecheck
```

`/api/_test/*` and `/api/_debug/*` are disabled unless `DEV_USER_TOKEN` is set
and the request carries `X-Dev-Auth: <token>`. Put `DEV_USER_TOKEN=…` in
`apps/worker/.dev.vars` (gitignored) to use the fixtures locally; a deployment
without that secret does not expose them at all.

`POST /api/v1/emails` answers with `{id}` as soon as the outbound row is
reserved; the provider call and inbox persistence finish in the background.
Poll `GET /api/v1/emails/:id` (or listen to webhooks / `…/events`) for the
outcome. The browser compose path still waits until the sent message is
persisted.

For a first-time deploy, see [DEPLOY.md](./DEPLOY.md). For one-time
Cloudflare Email Routing / Sending setup notes, see [CHECKLIST.md](./CHECKLIST.md).

## Status & known limitations

- **Webhook deliveries retry automatically.** Failed deliveries are retried
  by the cron sweep with backoff (5m / 30m / 2h / 5h) and marked dead after
  5 attempts. Scheduled sends (`scheduled_at`) are executed by the same
  sweep, so both work without any external queue.
- **One shared workspace.** Every account has a single owner and one shared set
  of domains/mail; members join that workspace, and there are no per-domain
  access lists yet. Host multiple independent teams as separate deployments.
- **Cloudflare Free plan** limits Email Sending to *verified* destinations
  only. Workers Paid removes that limit. Inbound (Email Routing) has no such
  restriction on Free.
- **Search is SQLite FTS5**, backfilled in the background on ingest. Very new
  messages may take a second to appear in search results.
