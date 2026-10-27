import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import { handlePush, sendPushToOwner } from "./push";

const USER: AuthUser = { id: "u_1", user_id: "u_1", email: "u@example.test", name: "U", role: "owner", is_new: false };
const OTHER: AuthUser = { id: "u_2", user_id: "u_2", email: "v@example.test", name: "V", role: "owner", is_new: false };

let db: DatabaseSyncType;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A realistic browser subscription: uncompressed P-256 point + 16-byte auth. */
async function browserKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: b64url(raw), auth: b64url(auth) };
}

async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicKey: b64url(pub), privateKey: jwk.d! };
}

function subscribeReq(body: unknown) {
  return new Request("https://worker.test/api/v1/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "test-agent" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = openDb();
  db.prepare(
    `INSERT INTO users (id,email,name,auth_provider,role,created_at)
     VALUES (?1,'u@example.test','U','magic_link','owner',0)`,
  ).run(USER.id);
  db.prepare(
    `INSERT INTO users (id,email,name,auth_provider,role,created_at)
     VALUES (?1,'v@example.test','V','magic_link','owner',0)`,
  ).run(OTHER.id);

  env = { DB: d1(db), ENV: "dev" } as unknown as Env;
  fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

describe("push key discovery", () => {
  it("reports disabled when VAPID secrets are absent", async () => {
    const res = await handlePush(
      new URL("https://worker.test/api/v1/push/key"),
      new Request("https://worker.test/api/v1/push/key"),
      env,
      USER,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      object: "push_key",
      enabled: false,
      public_key: null,
    });
  });

  it("reports enabled when all VAPID values are configured", async () => {
    const keys = await vapidKeys();
    env.VAPID_PUBLIC_KEY = keys.publicKey;
    env.VAPID_PRIVATE_KEY = keys.privateKey;
    env.VAPID_SUBJECT = "mailto:ops@example.test";
    const res = await handlePush(
      new URL("https://worker.test/api/v1/push/key"),
      new Request("https://worker.test/api/v1/push/key"),
      env,
      USER,
    );
    expect(await res.json()).toEqual({
      object: "push_key",
      enabled: true,
      public_key: keys.publicKey,
    });
  });
});

describe("push subscribe", () => {
  it("stores a subscription for the signed-in owner", async () => {
    const keys = await browserKeys();
    const res = await handlePush(
      new URL("https://worker.test/api/v1/push/subscribe"),
      subscribeReq({ endpoint: "https://push.example.test/abc", keys }),
      env,
      USER,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      object: "push_subscription",
      endpoint: "https://push.example.test/abc",
      subscribed: true,
    });

    const row = db
      .prepare(`SELECT owner_id, p256dh, auth, user_agent FROM push_subscriptions`)
      .get() as { owner_id: string; p256dh: string; auth: string; user_agent: string };
    expect(row).toEqual({
      owner_id: USER.id,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: "test-agent",
    });
  });

  it("upserts when the same endpoint subscribes again", async () => {
    const first = await browserKeys();
    const second = await browserKeys();
    for (const keys of [first, second]) {
      await handlePush(
        new URL("https://worker.test/api/v1/push/subscribe"),
        subscribeReq({ endpoint: "https://push.example.test/abc", keys }),
        env,
        USER,
      );
    }
    const rows = db
      .prepare(`SELECT p256dh FROM push_subscriptions WHERE owner_id = ?1`)
      .all(USER.id) as { p256dh: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe(second.p256dh);
  });

  it("rejects endpoints that are not https", async () => {
    const keys = await browserKeys();
    const res = await handlePush(
      new URL("https://worker.test/api/v1/push/subscribe"),
      subscribeReq({ endpoint: "http://push.example.test/abc", keys }),
      env,
      USER,
    );
    expect(res.status).toBe(422);
  });

  it("rejects a subscription without encryption keys", async () => {
    const res = await handlePush(
      new URL("https://worker.test/api/v1/push/subscribe"),
      subscribeReq({ endpoint: "https://push.example.test/abc", keys: {} }),
      env,
      USER,
    );
    expect(res.status).toBe(422);
  });

  it("rejects a non-JSON body", async () => {
    const res = await handlePush(
      new URL("https://worker.test/api/v1/push/subscribe"),
      new Request("https://worker.test/api/v1/push/subscribe", {
        method: "POST",
        body: "nope",
      }),
      env,
      USER,
    );
    expect(res.status).toBe(400);
  });
});

describe("push unsubscribe", () => {
  it("removes only the caller's endpoint", async () => {
    const keys = await browserKeys();
    for (const owner of [USER, OTHER]) {
      await handlePush(
        new URL("https://worker.test/api/v1/push/subscribe"),
        subscribeReq({ endpoint: `https://push.example.test/${owner.id}`, keys }),
        env,
        owner,
      );
    }

    const res = await handlePush(
      new URL("https://worker.test/api/v1/push/subscribe"),
      new Request("https://worker.test/api/v1/push/subscribe", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: `https://push.example.test/${USER.id}` }),
      }),
      env,
      USER,
    );
    expect(res.status).toBe(200);
    const remaining = db
      .prepare(`SELECT owner_id FROM push_subscriptions`)
      .all() as { owner_id: string }[];
    expect(remaining).toEqual([{ owner_id: OTHER.id }]);
  });

  it("requires an endpoint", async () => {
    const res = await handlePush(
      new URL("https://worker.test/api/v1/push/subscribe"),
      new Request("https://worker.test/api/v1/push/subscribe", { method: "DELETE" }),
      env,
      USER,
    );
    expect(res.status).toBe(422);
  });
});

describe("push delivery", () => {
  async function configure() {
    const vapid = await vapidKeys();
    env.VAPID_PUBLIC_KEY = vapid.publicKey;
    env.VAPID_PRIVATE_KEY = vapid.privateKey;
    env.VAPID_SUBJECT = "mailto:ops@example.test";
    const keys = await browserKeys();
    await handlePush(
      new URL("https://worker.test/api/v1/push/subscribe"),
      subscribeReq({ endpoint: "https://push.example.test/abc", keys }),
      env,
      USER,
    );
  }

  it("does nothing when VAPID is not configured", async () => {
    await sendPushToOwner(env, USER.id, { title: "a", body: "b" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts one encrypted, VAPID-signed request per subscription", async () => {
    await configure();
    await sendPushToOwner(env, USER.id, {
      title: "alice@example.test",
      body: "Hello there",
      url: "/inbox?thread=t_1",
      tag: "t_1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe("https://push.example.test/abc");
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("post");
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["ttl"]).toBe("3600");
    expect(headers["authorization"]).toMatch(/^vapid t=.+, k=.+$/);
    expect((init.body as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  it("drops subscriptions the push service says are gone", async () => {
    await configure();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 410 }));

    await sendPushToOwner(env, USER.id, { title: "a", body: "b" });

    const rows = db.prepare(`SELECT id FROM push_subscriptions`).all();
    expect(rows).toHaveLength(0);
  });

  it("keeps the subscription when delivery fails transiently", async () => {
    await configure();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    await sendPushToOwner(env, USER.id, { title: "a", body: "b" });

    const rows = db.prepare(`SELECT id FROM push_subscriptions`).all();
    expect(rows).toHaveLength(1);
  });

  it("a throwing push service never escapes into the mail pipeline", async () => {
    await configure();
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(
      sendPushToOwner(env, USER.id, { title: "a", body: "b" }),
    ).resolves.toBeUndefined();
  });
});
