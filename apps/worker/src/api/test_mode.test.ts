import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:email", () => ({
  EmailMessage: class {
    constructor(
      public from: string,
      public to: string,
      public raw: string,
    ) {}
  },
}));
vi.mock("../email/thread", () => ({ assignThread: vi.fn(async () => {}) }));
vi.mock("../webhooks/dispatch", () => ({ fanoutEvent: vi.fn(async () => {}) }));

import type { Env } from "../env";
import { sha256Hex } from "../utils/crypto";
import { d1, openDb } from "../test/sqlite";
import {
  authenticateApiKey,
  newToken,
  tokenPrefix,
  type ApiKeyAuth,
} from "./apikey_auth";
import { handleEmailSend } from "./emails";

const USER = "u_1";
const TEST_KEY: ApiKeyAuth = {
  user_id: USER,
  key_id: "k_test",
  scopes: ["emails.send"],
  domain_scope: null,
  test_mode: true,
};

let db: DatabaseSyncType;
let env: Env;
let emailSend: ReturnType<typeof vi.fn>;

function fakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

beforeEach(() => {
  db = openDb();
  db.prepare(
    `INSERT INTO users (id,email,name,auth_provider,role,created_at)
     VALUES (?1,'u@example.test','U','magic_link','owner',0)`,
  ).run(USER);
  db.prepare(
    `INSERT INTO domains (id,owner_id,domain,verification_status,created_at)
     VALUES ('d_1',?1,'example.test','verified',0)`,
  ).run(USER);
  emailSend = vi.fn(async () => {});
  env = {
    DB: d1(db),
    KV: fakeKv() as unknown as KVNamespace,
    R2: {} as unknown as R2Bucket,
    EMAIL: { send: emailSend } as unknown as SendEmail,
    ENV: "dev",
  } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function req(to: string, subject = "test", extra: object = {}) {
  return new Request("https://worker.test/api/v1/emails", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: "hello@example.test",
      to: [to],
      subject,
      text: "body",
      ...extra,
    }),
  });
}

async function send(to: string, subject = "test", extra: object = {}) {
  const res = await handleEmailSend(req(to, subject, extra), env, TEST_KEY);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function lastOutbound() {
  return db
    .prepare(
      `SELECT id, status, attempts, test_mode, bounce_type, sent_at
       FROM outbound_messages ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as Record<string, unknown>;
}

function events() {
  return db
    .prepare(`SELECT type FROM events ORDER BY rowid`)
    .all() as Array<{ type: string }>;
}

describe("test-mode sends", () => {
  it("records delivered@ without calling the provider or touching the inbox", async () => {
    const { status, body } = await send("delivered@example.org");
    expect(status).toBe(200);
    expect(body.id).toBeTypeOf("string");
    expect(emailSend).not.toHaveBeenCalled();

    const row = lastOutbound();
    expect(row).toMatchObject({ status: "delivered", attempts: 1, test_mode: 1 });
    expect(events()).toEqual([{ type: "email.delivered" }]);

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM send_usage`).get() as { n: number }).n,
    ).toBe(0);
  });

  it("simulates bounced and complained outcomes", async () => {
    await send("bounced@example.org");
    expect(lastOutbound()).toMatchObject({
      status: "bounced",
      bounce_type: "hard",
    });
    expect(events()).toEqual([{ type: "email.bounced" }]);

    await send("complained@example.org");
    expect(lastOutbound()).toMatchObject({
      status: "complained",
      bounce_type: "complaint",
    });
    expect(events()).toEqual([
      { type: "email.bounced" },
      { type: "email.complained" },
    ]);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("falls back to sent for an ordinary recipient", async () => {
    await send("someone@example.org");
    expect(lastOutbound()).toMatchObject({ status: "sent", test_mode: 1 });
    expect(events()).toEqual([{ type: "email.sent" }]);
  });

  it("rejects scheduled sends and works without the EMAIL binding", async () => {
    const scheduled = await send("delivered@example.org", "scheduled", {
      scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scheduled.status).toBe(422);

    const noEmail = { ...env, EMAIL: undefined } as Env;
    const res = await handleEmailSend(
      req("delivered@example.org", "no binding"),
      noEmail,
      TEST_KEY,
    );
    expect(res.status).toBe(200);
  });
});

describe("test key authentication", () => {
  it("uses the re_test_ prefix and authenticates as test_mode", async () => {
    const token = newToken(true);
    expect(token.startsWith("re_test_")).toBe(true);
    expect(tokenPrefix(token)).toHaveLength(12);
    expect(newToken(false).startsWith("re_live_")).toBe(true);

    const hash = await sha256Hex(token);
    db.prepare(
      `INSERT INTO api_keys
         (id, owner_id, name, prefix, key_hash, scopes_json, domain_scope_json,
          test_mode, created_at)
       VALUES ('k_test', ?1, 'test', ?2, ?3, '["emails.send"]', NULL, 1, 0)`,
    ).run(USER, tokenPrefix(token), hash);

    const reqAuth = new Request("https://worker.test/api/v1/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const result = await authenticateApiKey(reqAuth, env);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.auth.test_mode).toBe(true);
      expect(result.auth.key_id).toBe("k_test");
    }
  });
});
