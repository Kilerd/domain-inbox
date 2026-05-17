# Deploy `domain-inbox` to Cloudflare

A complete walkthrough for getting `domain-inbox` running on your own
Cloudflare account — from a single click, or step by step from a shell.

> Replace every `Kilerd/domain-inbox` below with the GitHub
> path of your fork. Replace `<your-domain.com>` with a domain you
> control and that already lives on Cloudflare nameservers.

---

## Option A — One-click deploy (recommended for first try)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Kilerd/domain-inbox)

Clicking the button will:

1. Fork this repo into your GitHub account.
2. Open Cloudflare's "Connect to Git" deploy flow.
3. Read `apps/worker/wrangler.toml` and prompt you to **create**
   matching resources on your account:
   - D1 database `domain-inbox-dev`
   - R2 bucket `domain-inbox-dev`
   - KV namespace (binding `KV`)
   - Email Sending binding `EMAIL`
   - Static assets from `apps/web/dist`
4. Rewrite the resource IDs in the forked `wrangler.toml`, commit, and
   trigger the first build + deploy.

### Build settings to enter in the deploy UI

| Field             | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| Root directory    | `/`                                                         |
| Build command     | `pnpm install && pnpm --filter @domain-inbox/web build`     |
| Deploy command    | `pnpm --filter @domain-inbox/worker exec wrangler deploy --env dev` |
| Package manager   | `pnpm`                                                      |
| Node version      | `20` or newer                                               |

> The button provisions the *bindings*, but Cloudflare cannot enable
> Email Routing or apply D1 migrations on your behalf. Continue with
> [§ Post-deploy steps](#post-deploy-steps) once the first deploy
> succeeds.

---

## Option B — Manual deploy from your shell

Use this path if you want full control, are deploying to staging/prod,
or the one-click flow does not fit your monorepo setup.

### 0. Prerequisites

- A Cloudflare account on the **Workers Paid** plan (Free is enough to
  install, but Email Sending is limited to verified destinations).
- A domain (`<your-domain.com>`) whose nameservers point to Cloudflare.
- Locally: `node >= 20`, `pnpm >= 10`, and the Cloudflare CLI
  (auto-installed via `wrangler` in this repo).

### 1. Clone, install, log in

```bash
git clone https://github.com/Kilerd/domain-inbox.git domain-inbox
cd domain-inbox
pnpm install
pnpm --filter @domain-inbox/worker exec wrangler login
```

### 2. Point `wrangler.toml` at your account

Edit `apps/worker/wrangler.toml` and replace the placeholders:

```toml
account_id = "<your-cf-account-id>"   # dash → right sidebar

[env.dev.vars]
PRIMARY_DOMAIN = "<your-domain.com>"
APP_BASE_URL   = "https://domain-inbox-dev.<your-workers-subdomain>.workers.dev"

[[env.dev.d1_databases]]
database_id = "<your-d1-database-id>"   # filled in by step 3

[[env.dev.kv_namespaces]]
id = "<your-kv-namespace-id>"           # filled in by step 3
```

> To keep your real IDs out of any future commits to the public repo,
> run `git update-index --skip-worktree apps/worker/wrangler.toml`
> after editing — git will then ignore local changes to this file.

### 3. Provision the bindings

Run each command and paste the printed ID back into the matching
section of `wrangler.toml`.

```bash
cd apps/worker

# D1
pnpm exec wrangler d1 create domain-inbox-dev
#   → copy the database_id into [[env.dev.d1_databases]]

# R2
pnpm exec wrangler r2 bucket create domain-inbox-dev

# KV
pnpm exec wrangler kv namespace create KV --env dev
#   → copy the id into [[env.dev.kv_namespaces]]
```

### 4. Apply D1 migrations

```bash
pnpm exec wrangler d1 migrations apply domain-inbox-dev --env dev --remote
```

### 5. Build the SPA and deploy the Worker

```bash
# from the repo root
pnpm --filter @domain-inbox/web build
pnpm --filter @domain-inbox/worker run deploy:dev
```

On success, `wrangler` prints the Worker URL
(`https://domain-inbox-dev.<your-workers-subdomain>.workers.dev`).

---

## Post-deploy steps

These apply to **both** Option A and Option B. They cannot be
automated by Cloudflare's deploy flow today.

### 1. Enable Email Routing on your domain

1. Cloudflare dashboard → **Email** → **Email Routing** →
   pick `<your-domain.com>` → **Get started**.
2. Wait for Cloudflare to add the MX + SPF records (auto).
3. **Routing Rules** → **Catch-all address** →
   **Action**: *Send to a Worker* → choose `domain-inbox-dev` →
   **Save**.

Enabling Email Routing also publishes the DKIM record at
`cf2024-N._domainkey.<your-domain.com>`. Cloudflare **Email Sending
reuses the same DKIM**, so you do *not* need a separate Email Sending
setup — sending works as soon as Routing is on.

### 2. Set secrets (only what you actually need)

```bash
cd apps/worker

# Required if you want a quick dev login bypass:
pnpm exec wrangler secret put DEV_USER_TOKEN --env dev

# Optional: lets the SPA's "Settings → Add domain" auto-enable
# Email Routing on new zones. Token scopes: Zone:Read + Zone:Email Routing Edit.
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --env dev

# Optional: webhook signing secret for outbound email.sent/failed events.
pnpm exec wrangler secret put WEBHOOK_SIGNING_SECRET --env dev
```

### 3. (Prod only) Put Cloudflare Access in front of the SPA

The dev environment uses `DEV_USER_TOKEN` as an auth backdoor. Before
exposing the UI publicly, switch to Cloudflare Access:

1. Zero Trust → **Access** → **Applications** → **Add** → *Self-hosted*.
2. Application domain: `domain-inbox-prod.<your-workers-subdomain>.workers.dev`.
3. Identity provider: One-Time PIN (email), Google, GitHub, etc.
4. Policy: *Allow* → list the emails that should reach the inbox.
5. Copy the **AUD tag** shown after saving.
6. In `apps/worker/wrangler.toml` under `[env.prod.vars]`:
   ```toml
   ACCESS_TEAM_DOMAIN = "<your-team>"
   ACCESS_AUD         = "<aud-tag>"
   # and *remove* DEV_USER_EMAIL / DEV_USER_NAME
   ```
7. `pnpm --filter @domain-inbox/worker run deploy:prod`.

---

## Verify the deployment

```bash
# 1. Send a real email from any address to test@<your-domain.com>
#    → it should appear in the SPA inbox within ~2 seconds (SSE-pushed).

# 2. Mint an API token in the SPA (Settings → API keys), then:
BASE_URL=https://domain-inbox-dev.<your-workers-subdomain>.workers.dev/api/v1 \
  API_TOKEN=<your re_live_xxx>                                               \
  FROM_DOMAIN=<your-domain.com>                                              \
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
| `POST /api/v1/emails` returns `Sender not allowed`     | The from-domain has no DKIM yet → enable Email Routing on that domain.                       |
| SPA loads but every page is blank with a 401           | Dev backdoor not configured. Set `DEV_USER_TOKEN` secret *and* send the `X-Dev-Auth` header. |
| One-click button created resources but deploy failed   | Most often the build command is wrong — the SPA must be built before `wrangler deploy`.      |

For any other issue, `pnpm --filter @domain-inbox/worker run tail:dev`
will show the request that broke, with the original error.
