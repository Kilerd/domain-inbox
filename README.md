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
- **All on Cloudflare.** D1 for metadata, R2 for raw MIME, KV for fast token
  lookup. No external services.

## Drop-in for existing Resend users

No SDK swap, no code changes — one env var:

```ts
import { Resend } from "resend";

process.env.RESEND_BASE_URL = "https://domain-inbox.<your-subdomain>.workers.dev/api/v1";
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

Compatibility is end-to-end verified by `scripts/resend-compat-smoke.mjs`
(runs the unmodified `resend` package against the Worker) and
`scripts/webhook-signature-check.mjs` (cross-checks signatures with the
official Svix SDK).

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Kilerd/domain-inbox)

The button forks the repo, provisions the D1 / R2 / KV / Email Sending
bindings, and ships the first deploy. Two post-deploy steps Cloudflare can't
automate: enable **Email Routing** on your domain, and apply **D1 migrations**.

See [DEPLOY.md](./DEPLOY.md) for the 2-minute walkthrough (and the fully
manual `wrangler` path).

## How it works

One Worker, three entry points:

```
Inbound mail   ─►  email() handler  ─►  postal-mime  ─►  D1 + R2  ─►  SSE push to SPA
HTTP + SPA     ─►  fetch() handler  ─►  /api/v1/* (Resend-compatible) + inbox routes
Outbound send  ─►  env.EMAIL.send() ─►  Svix-signed webhook fan-out
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

# Worker only — wrangler dev on http://127.0.0.1:8787
pnpm --filter @domain-inbox/worker run dev

# SPA against a remote dev worker
VITE_API_PROXY_TARGET=https://domain-inbox-dev.<your-subdomain>.workers.dev \
  pnpm --filter @domain-inbox/web run dev

# Tests + typecheck
pnpm --filter @domain-inbox/worker run test
pnpm --filter @domain-inbox/worker run typecheck
```

For a first-time deploy, see [DEPLOY.md](./DEPLOY.md). For one-time
Cloudflare Email Routing / Sending setup notes, see [CHECKLIST.md](./CHECKLIST.md).

## Status & known limitations

- **Single-tenant today.** Rows are scoped by `owner_id`, so inviting a second
  user currently shows them an empty inbox. Multi-tenant refactor is on the
  roadmap before this is safe to host for multiple humans.
- **Cloudflare Free plan** limits Email Sending to *verified* destinations
  only. Workers Paid removes that limit. Inbound (Email Routing) has no such
  restriction on Free.
- **No full-text message search yet.** Lookups today are by sender, subject
  prefix, and thread; SQLite FTS5 over the corpus is planned.
