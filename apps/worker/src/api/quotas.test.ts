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
import { d1, openDb } from "../test/sqlite";
import type { ApiKeyAuth } from "./apikey_auth";
import { handleEmailSend } from "./emails";
import { consumeSendQuota, utcDay } from "./quotas";

const USER = "u_1";
const KEY: ApiKeyAuth = {
  user_id: USER,
  key_id: "k_1",
  scopes: ["emails.send"],
  domain_scope: null,
};

let db: DatabaseSyncType;
let env: Env;

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
    `INSERT INTO domains (id,owner_id,domain,verification_status,created_at,open_tracking,click_tracking)
     VALUES ('d_1',?1,'example.test','verified',0,0,0)`,
  ).run(USER);
  env = {
    DB: d1(db),
    KV: fakeKv() as unknown as KVNamespace,
    R2: { put: vi.fn(async () => null) } as unknown as R2Bucket,
    EMAIL: { send: vi.fn(async () => {}) } as unknown as SendEmail,
    ENV: "dev",
    SEND_DAILY_LIMIT: "1",
  } as unknown as Env;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function req(subject: string, idem?: string) {
  return new Request("https://worker.test/api/v1/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idem ? { "Idempotency-Key": idem } : {}),
    },
    body: JSON.stringify({
      from: "hello@example.test",
      to: ["a@b.test"],
      subject,
      text: "hi",
    }),
  });
}

describe("send quota", () => {
  it("caps one owner per UTC day and resets the next day", async () => {
    const now = Date.UTC(2026, 0, 1, 12);
    expect(await consumeSendQuota(env, USER, now)).toBe(true);
    expect(await consumeSendQuota(env, USER, now)).toBe(false);
    expect(await consumeSendQuota(env, USER, now + 86_400_000)).toBe(true);

    db.prepare(
      `INSERT INTO users (id,email,name,auth_provider,role,created_at)
       VALUES ('u_2','x@example.test','X','magic_link','owner',0)`,
    ).run();
    expect(await consumeSendQuota(env, "u_2", now)).toBe(true);
    expect(utcDay(now)).toBe("2026-01-01");
  });

  it("answers 429 at the cap without inserting a row", async () => {
    expect((await handleEmailSend(req("one"), env, KEY)).status).toBe(200);

    const second = await handleEmailSend(req("two"), env, KEY);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { name: string }).name).toBe(
      "rate_limit_exceeded",
    );

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM outbound_messages`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("does not charge an idempotent replay", async () => {
    expect((await handleEmailSend(req("same", "idem-1"), env, KEY)).status).toBe(200);
    expect((await handleEmailSend(req("same", "idem-1"), env, KEY)).status).toBe(200);

    // The only quota unit went to the original send.
    expect((await handleEmailSend(req("other"), env, KEY)).status).toBe(429);
  });
});
