// Verifies that our worker's Svix-style signature output matches an independent
// Node HMAC implementation, then exercises the Resend SDK's official
// `resend.webhooks` verifier against the same signature.

import crypto from "node:crypto";
import { Webhook } from "svix";

const BASE = process.env.BASE_URL;
if (!BASE) {
  console.error("BASE_URL env var is required (e.g. https://domain-inbox-dev.<your-subdomain>.workers.dev)");
  process.exit(1);
}

function signNode(secret, msgId, ts, body) {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = Buffer.from(raw, "base64");
  const toSign = `${msgId}.${ts}.${body}`;
  const sig = crypto.createHmac("sha256", keyBytes).update(toSign).digest("base64");
  return `v1,${sig}`;
}

// Test fixture only — random bytes, never used as a real production secret.
const secret = "whsec_C33O2UPyhVJa20p0vK2XoGLn+IgWk9njB6LiEXLgX68=";
const msgId = "msg_test_42";
const timestamp = Math.floor(Date.now() / 1000);
const body = JSON.stringify({ type: "email.sent", data: { id: "o_x" } });

const sigNode = signNode(secret, msgId, timestamp, body);
console.log("node     sig:", sigNode);

const workerRes = await fetch(`${BASE}/api/_test/sign`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret, msg_id: msgId, timestamp, body }),
});
const { signature: sigWorker } = await workerRes.json();
console.log("worker   sig:", sigWorker);

if (sigNode !== sigWorker) {
  console.error("\n❌ signatures do not match");
  process.exit(2);
}
console.log("\n✅ HMAC parity Node <-> Worker");

// Verify with the official Svix SDK (which Resend's webhooks library wraps).
const wh = new Webhook(secret);
try {
  const verified = wh.verify(body, {
    "svix-id": msgId,
    "svix-timestamp": String(timestamp),
    "svix-signature": sigWorker,
  });
  console.log("Svix verify accepted; payload type:", verified.type);
  console.log("\n✅ Svix SDK accepts our signature");
} catch (e) {
  console.error("Svix verify threw:", e.message);
  process.exit(3);
}
