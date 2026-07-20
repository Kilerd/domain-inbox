# Deploy `domain-inbox` to Cloudflare

A complete walkthrough for getting `domain-inbox` running on your own
Cloudflare account with `wrangler`.

> Replace every `Kilerd/domain-inbox` below with the GitHub
> path of your fork. Replace `<your-domain.com>` with a domain you
> control and that already lives on Cloudflare nameservers.

**Environment layout** (see `apps/worker/wrangler.toml`): the **top-level
config is production** — deploy it with a plain `wrangler deploy`
(`pnpm run deploy:prod`). `[env.dev]` and `[env.staging]` are separate
named environments with their own resources, deployed with `--env dev` /
`--env staging`. There is no `[env.prod]`.

The examples below use the **dev** environment. For production, drop the
`--env dev` flag and use the un-suffixed resource names (`domain-inbox`
instead of `domain-inbox-dev`).

---

## Deploy from your shell

### 0. Prerequisites

- A Cloudflare account. **Workers Paid** recommended: on Free, Email
  Sending can only deliver to *verified* destination addresses (inbound
  Email Routing is unrestricted on Free).
- A domain (`<your-domain.com>`) whose nameservers point to Cloudflare.
- Locally: `node >= 20`, `pnpm >= 10` (`corepack enable`), and the
  Cloudflare CLI (installed as the `wrangler` devDependency in this repo).

### 1. Clone, install, log in

```bash
git clone https://github.com/Kilerd/domain-inbox.git domain-inbox
cd domain-inbox
pnpm install
pnpm --filter @domain-inbox/worker exec wrangler login
```

### 2. Provision the resources

Each environment needs its own D1 database, R2 bucket, and KV namespace.
For **dev**:

```bash
cd apps/worker

# D1
pnpm exec wrangler d1 create domain-inbox-dev
#   → copy the printed database_id into [[env.dev.d1_databases]]

# R2
pnpm exec wrangler r2 bucket create domain-inbox-dev

# KV
pnpm exec wrangler kv namespace create KV --env dev
#   → copy the printed id into [[env.dev.kv_namespaces]]
```

For **production**, repeat with the un-suffixed names and paste the ids
into the *top-level* sections:

```bash
pnpm exec wrangler d1 create domain-inbox         # → [[d1_databases]]
pnpm exec wrangler r2 bucket create domain-inbox
pnpm exec wrangler kv namespace create KV         # → [[kv_namespaces]]
```

The Email Sending binding (`EMAIL`) and static assets need no
provisioning step — they are declared in `wrangler.toml` and activated
by the Email Routing setup in [§ Post-deploy](#post-deploy-steps).

### 3. Fill in `wrangler.toml`

Edit `apps/worker/wrangler.toml` and replace every `<placeholder>`
marker for the environment(s) you deploy:

```toml
account_id = "<your-cloudflare-account-id>"   # dash → right sidebar

[env.dev.vars]
PRIMARY_DOMAIN = "<your-domain.com>"
# REQUIRED — magic-link sign-in emails refuse to send without it
# (the server will not derive the link from the Host header).
APP_BASE_URL   = "https://domain-inbox-dev.<your-workers-subdomain>.workers.dev"

[[env.dev.d1_databases]]
database_id = "<your-d1-database-id>"   # from step 2

[[env.dev.kv_namespaces]]
id = "<your-kv-namespace-id>"           # from step 2
```

`APP_BASE_URL` is **required**: login emails contain absolute magic-link
URLs, and the Worker refuses to send them if the var is unset (deriving
the link from the incoming `Host` header would open a Host-header-injection
hole). Set it to the exact URL users will visit.

> **Keeping real ids out of a public fork:** resource ids are not
> secrets, so the simplest option is to commit them in your (private or
> public) fork. If you'd rather not, keep the edits uncommitted locally —
> but note the tradeoff: any git-connected build (CI, Cloudflare's
> git integration) sees the committed file, so uncommitted local edits
> only work for deploys from your own shell. Do **not** use
> `git update-index --skip-worktree` — it silently desyncs your checkout
> from what git-connected deploys build.

### 4. Apply D1 migrations

Migrations live in `apps/worker/migrations/` (currently `0001` through
`0007_dedup_scope_webhook_retry.sql`). Apply them to the remote database
after creating it — and again whenever you pull a version that adds one:

```bash
cd apps/worker

# dev
pnpm exec wrangler d1 migrations apply domain-inbox-dev --env dev --remote

# production
pnpm exec wrangler d1 migrations apply domain-inbox --remote
```

### 5. Build the SPA, then deploy the Worker

The Worker serves the SPA from `../web/dist` via the `ASSETS` binding,
so the web build must exist **before** `wrangler deploy`:

```bash
# from the repo root
pnpm --filter @domain-inbox/web run build

pnpm --filter @domain-inbox/worker run deploy:dev    # dev
pnpm --filter @domain-inbox/worker run deploy:prod   # production (plain `wrangler deploy`)
```

On success, `wrangler` prints the Worker URL
(`https://domain-inbox-dev.<your-workers-subdomain>.workers.dev`).

The deploy also registers the `*/2 * * * *` cron trigger declared in
`wrangler.toml` — it drives scheduled sends (`scheduled_at`) and webhook
delivery retries, so don't remove it.

---

## Post-deploy steps

### 1. Enable Email Routing on your domain

1. Cloudflare dashboard → **Email** → **Email Routing** →
   pick `<your-domain.com>` → **Get started**.
2. Wait for Cloudflare to add the MX + SPF records (auto).
3. **Routing Rules** → **Catch-all address** →
   **Action**: *Send to a Worker* → choose `domain-inbox-dev` (or
   `domain-inbox` for production) → **Save**.

Enabling Email Routing also publishes the DKIM record at
`cf2024-N._domainkey.<your-domain.com>`. Cloudflare **Email Sending
reuses the same DKIM**, so you do *not* need a separate Email Sending
setup — sending works as soon as Routing is on.

### 2. Set secrets (only what you actually need)

```bash
cd apps/worker

# Optional, dev only: enables the auth backdoor for requests carrying
# a matching `X-Dev-Auth` header. Never set this on production.
pnpm exec wrangler secret put DEV_USER_TOKEN --env dev

# Optional: lets the SPA's "Settings → Add domain" auto-enable
# Email Routing / DNS on new zones. Token scopes: Zone:Read +
# Zone:Email Routing Edit.
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --env dev   # or omit --env for prod
```

There is no webhook signing secret to set: webhook secrets are generated
**per endpoint** when you create the endpoint in the UI / API, and stored
as rows in D1.

### 3. (Prod only) Put Cloudflare Access in front of the SPA

Before exposing the UI publicly, switch to Cloudflare Access:

1. Zero Trust → **Access** → **Applications** → **Add** → *Self-hosted*.
2. Application domain: `domain-inbox.<your-workers-subdomain>.workers.dev`.
3. Identity provider: One-Time PIN (email), Google, GitHub, etc.
4. Policy: *Allow* → list the emails that should reach the inbox.
5. Copy the **AUD tag** shown after saving.
6. In `apps/worker/wrangler.toml`, uncomment under the top-level `[vars]`:
   ```toml
   ACCESS_TEAM_DOMAIN = "<your-team>"
   ACCESS_AUD         = "<application-aud-tag>"
   ```
7. `pnpm --filter @domain-inbox/worker run deploy:prod`.

---

## What about the Deploy-to-Cloudflare button?

An honest caveat: the one-click **Deploy to Cloudflare** button does
**not** work for this repo today. This is a pnpm monorepo with the
Worker config in `apps/worker/`, and the `send_email` (Email Sending)
binding cannot be auto-provisioned by the deploy flow. Use the shell
walkthrough above — it is the supported path.

If you wire up Cloudflare's git-connected builds *after* a first manual
deploy, use root directory `/`, build command
`pnpm install && pnpm --filter @domain-inbox/web run build`, and deploy
command `pnpm --filter @domain-inbox/worker exec wrangler deploy`
(add `--env dev` for the dev Worker). Migrations and Email Routing still
have to be done by hand, and `wrangler.toml` placeholders must be filled
in the committed file for git-connected builds to see them.

---

## Verify the deployment

```bash
# 1. Send a real email from any address to test@<your-domain.com>
#    → it should appear in the SPA inbox within ~2 seconds (SSE-pushed).

# 2. Mint an API token in the SPA (Settings → API keys), then:
BASE_URL=https://domain-inbox-dev.<your-workers-subdomain>.workers.dev/api/v1 \
  API_TOKEN=<your re_live_xxx>                                               \
  FROM_DOMAIN=<your-domain.com>                                              \
  RECIPIENT=<an-address-you-control>                                         \
  node scripts/resend-compat-smoke.mjs

# 3. Tail logs while testing:
pnpm --filter @domain-inbox/worker run tail:dev
```

---

## Troubleshooting

| Symptom                                                | Likely cause / fix                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Deploy succeeds, inbound email never arrives           | Email Routing not enabled, or the catch-all is set to "forward" instead of "send to Worker". |
| `D1_ERROR: no such table` on first request             | You skipped `wrangler d1 migrations apply` — run it against the remote D1.                   |
| Magic-link sign-in emails never send                   | `APP_BASE_URL` is unset for that environment — fill it in `wrangler.toml` and redeploy.      |
| `POST /api/v1/emails` returns `Sender not allowed`     | The from-domain has no DKIM yet → enable Email Routing on that domain.                       |
| SPA loads but every page is blank with a 401           | Dev backdoor not configured. Set `DEV_USER_TOKEN` secret *and* send the `X-Dev-Auth` header. |
| Scheduled sends / webhook retries never fire           | The cron trigger is missing — keep `[triggers] crons` in `wrangler.toml` and redeploy.       |
| Deploy fails complaining about `../web/dist`           | The SPA wasn't built — run `pnpm --filter @domain-inbox/web run build` before deploying.     |

For any other issue, `pnpm --filter @domain-inbox/worker run tail:dev`
will show the request that broke, with the original error. Workers Logs
(`[observability]` is enabled in `wrangler.toml`) keeps history in the
dashboard as well.
