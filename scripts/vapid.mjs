#!/usr/bin/env node
// Generate the VAPID P-256 keypair used for Web Push, in the format the
// Worker expects: base64url raw public key (87 chars) + base64url JWK "d".
//
//   node scripts/vapid.mjs >> apps/worker/.dev.vars
//
// For production, pipe each line into `wrangler secret put` instead of
// committing the private key.

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

process.stdout.write(`VAPID_PUBLIC_KEY=${b64url(raw)}\n`);
process.stdout.write(`VAPID_PRIVATE_KEY=${jwk.d}\n`);
process.stdout.write(`VAPID_SUBJECT=mailto:ops@example.com\n`);
