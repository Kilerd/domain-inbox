import crypto from "node:crypto";
import { describe, expect, test } from "vitest";
import { svixSign } from "./dispatch";

function nodeSign(secret: string, msgId: string, ts: number, body: string): string {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = Buffer.from(raw, "base64");
  const sig = crypto
    .createHmac("sha256", keyBytes)
    .update(`${msgId}.${ts}.${body}`)
    .digest("base64");
  return `v1,${sig}`;
}

// Test fixture only — random bytes, never used as a real production secret.
const FIXTURE_SECRET = "whsec_C33O2UPyhVJa20p0vK2XoGLn+IgWk9njB6LiEXLgX68=";

describe("svixSign", () => {
  test("matches Node HMAC byte-for-byte", async () => {
    const secret = FIXTURE_SECRET;
    const msgId = "msg_abc";
    const ts = 1700000000;
    const body = '{"hello":"world"}';

    const ours = await svixSign(secret, msgId, ts, body);
    const ref = nodeSign(secret, msgId, ts, body);

    expect(ours).toBe(ref);
  });

  test("different bodies produce different signatures", async () => {
    const secret = FIXTURE_SECRET;
    const a = await svixSign(secret, "id1", 1, "a");
    const b = await svixSign(secret, "id1", 1, "b");
    expect(a).not.toBe(b);
  });

  test("accepts secret without whsec_ prefix", async () => {
    const raw = FIXTURE_SECRET.slice("whsec_".length);
    const withPrefix = FIXTURE_SECRET;
    const a = await svixSign(withPrefix, "id1", 1, "x");
    const b = await svixSign(raw, "id1", 1, "x");
    expect(a).toBe(b);
  });
});
