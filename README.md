# domain-inbox

Multi-domain email service on Cloudflare. Receive any address on your domains,
send via a Resend-compatible HTTP API, manage everything from a single web UI.

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

See [CHECKLIST.md](./CHECKLIST.md) for the one-time CF Email Routing/Sending
manual setup that requires `email_routing:write` OAuth scope.

The full implementation plan is at
`/Users/chenxin/.claude/plans/cloudflare-worker-keen-tome.md`.
