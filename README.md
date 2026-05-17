# domain-inbox

**Domain email + Resend alternative, powered by Cloudflare.** Receive mail on
any address across any number of your domains, send transactional email through
a drop-in [Resend](https://resend.com)-compatible HTTP API, and manage
everything from a single web UI — all on one Cloudflare Worker.

## Drop-in Resend replacement

Already using the official Resend SDK? Point it at this Worker with one
environment variable — **no SDK swap, no code changes**:

```ts
// Node / Bun / Deno — works with the unmodified `resend` package
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

Same idempotency keys, batch endpoint, `GET /emails/:id`, webhooks signed with
Svix-compatible HMAC — all verified against the official Resend Node SDK and
the official Svix verifier (see `scripts/resend-compat-smoke.mjs` and
`scripts/webhook-signature-check.mjs`).

## Deploy to your own Cloudflare account

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Kilerd/domain-inbox)

The button forks the repo, provisions the D1 / R2 / KV / Email Sending
bindings declared in [`apps/worker/wrangler.toml`](./apps/worker/wrangler.toml),
and triggers the first deploy. Cloudflare cannot enable **Email Routing** or
apply **D1 migrations** on your behalf — see [DEPLOY.md](./DEPLOY.md) for the
two-minute post-deploy steps (and for the fully manual `wrangler` flow).

## Features (all verified end-to-end)

- **Inbound** — Email Routing → Worker `email()` handler → `postal-mime` parse →
  R2 raw MIME store + D1 metadata + attachment sha256 dedup + thread aggregation
  (In-Reply-To / References / 14-day subject window)
- **Web UI** — Vite + React + TanStack Query + Tailwind two-column inbox,
  HTMLRewriter-sanitized email rendering inside `<iframe sandbox>` with strict
  CSP, referer-stripping image proxy, dark mode, SSE realtime push
- **Outbound** — Cloudflare Email Sending via `env.EMAIL.send()`, with a
  Resend-compatible HTTP API (`POST /api/v1/emails`, batch, GET/PATCH/cancel,
  idempotency 24h)
- **Webhooks** — Outbound `email.sent / failed` events with Svix-compatible
  signing (`svix-id`, `svix-timestamp`, `svix-signature`); independently
  verified against the official Svix SDK
- **Auth** — Cloudflare Access JWT for Web (with dev-mode bypass for local
  testing); `re_live_xxx` Bearer tokens for the Resend-style API, hashed in D1
  + KV-cached for fast lookup

## Layout

```
apps/
  worker/      single Cloudflare Worker (fetch + email + queue handlers + assets)
    src/
      api/       Resend-compatible + inbox routes
      email/     ingest → parse → thread pipeline
      webhooks/  Svix-signed fan-out dispatcher
      auth.ts    Cloudflare Access JWT verifier + dev fallback
    migrations/  D1 schema (0001_init.sql)
  web/         Vite + React + Tailwind SPA
scripts/       smoke tests: Resend SDK compat, webhook signature parity
```

## Quick start

```bash
pnpm install
pnpm --filter @domain-inbox/worker run deploy:dev
pnpm --filter @domain-inbox/worker run tail:dev
```

For Resend SDK compatibility:
```bash
RESEND_BASE_URL=https://domain-inbox-dev.<your-subdomain>.workers.dev/api/v1 \
  API_TOKEN=<your re_live_xxx> \
  node scripts/resend-compat-smoke.mjs
```

See [DEPLOY.md](./DEPLOY.md) for the full deploy walkthrough and
[CHECKLIST.md](./CHECKLIST.md) for the one-time Cloudflare Email
Routing/Sending manual setup notes.
