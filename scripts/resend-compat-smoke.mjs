// Resend Node SDK end-to-end compatibility smoke test.
//
// Verifies that an unmodified `resend` SDK pointed at our worker's base URL
// can: (1) send an email, (2) GET it by id, (3) replay idempotency safely.
//
// NOTE: this sends real email. All four env vars are required — there are
// no defaults, so mail is never sent from/to reserved example domains.
//
// Usage:
//   API_TOKEN=re_live_xxx \
//   BASE_URL=https://domain-inbox-dev.<your-subdomain>.workers.dev/api/v1 \
//   FROM_DOMAIN=<your-domain.com> \
//   RECIPIENT=<an-address-you-control> \
//     node resend-compat-smoke.mjs

import { Resend } from "resend";

const REQUIRED = {
  API_TOKEN: "an API token minted in the SPA (re_live_xxx)",
  BASE_URL: "worker API base, e.g. https://domain-inbox-dev.<your-subdomain>.workers.dev/api/v1",
  FROM_DOMAIN: "a domain you own with Email Routing enabled (mail is sent from hello@<FROM_DOMAIN>)",
  RECIPIENT: "a real mailbox you control that will receive the probe email",
};
const missing = Object.keys(REQUIRED).filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("Missing required env vars — this script sends real email, so nothing is defaulted:");
  for (const k of missing) console.error(`  ${k}  — ${REQUIRED[k]}`);
  process.exit(1);
}

const { API_TOKEN, BASE_URL, FROM_DOMAIN, RECIPIENT } = process.env;

// resend-node honors RESEND_BASE_URL when constructing its internal client.
process.env.RESEND_BASE_URL = BASE_URL;

const resend = new Resend(API_TOKEN);
const idem = `compat-${Date.now()}`;

console.log(`> POST ${BASE_URL}/emails (idem=${idem})`);
const sent = await resend.emails.send(
  {
    from: `Domain Inbox <hello@${FROM_DOMAIN}>`,
    to: [RECIPIENT],
    subject: "Resend SDK compat probe",
    html: "<p>Hello from <b>resend-node</b>.</p>",
    text: "Hello from resend-node.",
    headers: { "X-Compat-Probe": idem },
    tags: [{ name: "test", value: "compat" }],
  },
  { idempotencyKey: idem },
);
console.log("  send result:", JSON.stringify(sent));
if (sent.error) {
  console.error("send failed");
  process.exit(2);
}
const id = sent.data.id;

console.log(`> POST again with same idempotency-key — expect same id`);
const sent2 = await resend.emails.send(
  {
    from: `hello@${FROM_DOMAIN}`,
    to: [RECIPIENT],
    subject: "Resend SDK compat probe",
    text: "Hello",
  },
  { idempotencyKey: idem },
);
console.log("  replay result:", JSON.stringify(sent2));
if (sent2.data?.id !== id) {
  console.error(`idempotency replay returned different id: ${sent2.data?.id} (expected ${id})`);
  process.exit(3);
}

console.log(`> GET ${BASE_URL}/emails/${id}`);
const got = await resend.emails.get(id);
console.log("  get result:", JSON.stringify(got));
if (got.error) {
  console.error("get failed");
  process.exit(4);
}
if (got.data.id !== id) {
  console.error(`get returned wrong id: ${got.data.id}`);
  process.exit(5);
}

console.log("\n✅ resend SDK compatibility smoke OK");
