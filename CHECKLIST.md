# Manual setup

## What's already verified end-to-end

Once deployed and configured per [DEPLOY.md](./DEPLOY.md), the worker is
**fully operational** for both inbound and outbound mail on the domain you
attached to Email Routing:

- Sending a real email from any external address to `*@<your-domain.com>`
  → appears in the SPA inbox within ~2 seconds (SSE-pushed).
- `POST /api/v1/emails` via the API → lands in the recipient's real inbox
  (verified against Gmail).

## What's still nice-to-have, not blocking

### Cloudflare API token (only if you want `Settings → Add domain` automated)

Without this, you'd add a new domain by:
1. Adding the zone to Cloudflare DNS,
2. Settings → Add domain in the SPA,
3. One-time dashboard click: Email → Email Routing → Enable + set catch-all
   to "Send to a Worker → domain-inbox-dev".

If you'd rather have step 3 happen automatically, mint a token with
`Zone:Read` + `Zone:Email Routing Edit`, then:
```bash
cd apps/worker
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --env dev
```

That's optional convenience — not a real blocker.

### Cloudflare Access (before promoting to staging/prod)

The dev worker has an auth backdoor gated on the `DEV_USER_TOKEN` secret
(requests must carry a matching `X-Dev-Auth` header). For prod:

1. Zero Trust → Access → Applications → Add → Self-hosted
2. Application domain: `<your worker subdomain>.workers.dev`
3. Identity provider: One-Time PIN (email) or your IdP
4. Policy: Allow → emails listed
5. Copy the **AUD tag**
6. In `apps/worker/wrangler.toml`, under the top-level `[vars]`
   (the top-level config *is* production — there is no `[env.prod]`):
   ```toml
   ACCESS_TEAM_DOMAIN = "<your-team>"
   ACCESS_AUD = "<aud-tag>"
   ```
7. `pnpm exec wrangler deploy` (or `pnpm --filter @domain-inbox/worker run deploy:prod`)

## Key learning (from real-world testing)

CF Email Routing's "Enable" automatically provisions the DKIM key at
`cf2024-N._domainkey.<domain>`. Email Sending **reuses the same DKIM**,
so a domain that has Email Routing turned on is *already* ready to send —
there's no separate "Add domain in Email Sending" step you need to perform.
