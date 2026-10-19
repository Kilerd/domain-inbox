import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
import type { ApiKeyAuth } from "./apikey_auth";
import { handleEmailSend } from "./emails";
import {
  IDEMPOTENCY_WINDOW_MS,
  canonicalJson,
  decodeCacheEntry,
  idempotencyCacheKey,
  releaseExpiredIdempotencyKeys,
  remainingWindowTtl,
  requestFingerprint,
  resolveReservationConflict,
} from "./idempotency";

// vite-node can't resolve the prefix-only `node:sqlite` builtin through a
// static import, so fetch it from the runtime directly.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const USER = "u_1";
const KEY = "outbox-row-1";
const API_KEY: ApiKeyAuth = { user_id: USER, key_id: "k_1", scopes: ["emails.send"], domain_scope: null };
const BODY = {
  from: "Hub <hello@example.com>",
  to: ["someone@example.org"],
  subject: "Order #1",
  text: "Thanks for your order.",
};

// Real SQLite with every migration applied, behind a minimal D1 facade, so
// the UNIQUE reservation and the created_at comparisons run for real.
function openDb(): DatabaseSyncType {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  db.prepare(
    `INSERT INTO domains (id, owner_id, domain, verification_status, created_at, open_tracking, click_tracking)
     VALUES ('d_1', ?1, 'example.com', 'verified', 0, 0, 0)`,
  ).run(USER);
  return db;
}

function d1(db: DatabaseSyncType, beforeRun?: (sql: string) => void): D1Database {
  return {
    prepare(sql: string) {
      let params: SQLInputValue[] = [];
      const stmt = {
        bind(...p: unknown[]) {
          params = p as SQLInputValue[];
          return stmt;
        },
        async first() {
          const row = db.prepare(sql).get(...params);
          return row ? { ...row } : null;
        },
        async all() {
          const results = db.prepare(sql).all(...params).map((r) => ({ ...r }));
          return { results, success: true, meta: {} };
        },
        async run() {
          beforeRun?.(sql);
          const r = db.prepare(sql).run(...params);
          return { results: [], success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

// KV fake that honours expirationTtl against the (faked) clock and rejects
// TTLs below Cloudflare's 60 s minimum.
function fakeKv() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const puts: Array<{ key: string; value: string; ttl: number | undefined }> = [];
  const ns = {
    async get(key: string) {
      const e = store.get(key);
      if (!e || (e.expiresAt !== null && Date.now() >= e.expiresAt)) return null;
      return e.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      const ttl = opts?.expirationTtl;
      if (ttl !== undefined && ttl < 60) throw new Error(`KV put: invalid expiration_ttl ${ttl}`);
      puts.push({ key, value, ttl });
      store.set(key, { value, expiresAt: ttl === undefined ? null : Date.now() + ttl * 1000 });
    },
  };
  return { store, puts, ns: ns as unknown as KVNamespace };
}

let db: DatabaseSyncType;
let kv: ReturnType<typeof fakeKv>;
let emailSend: ReturnType<typeof vi.fn>;
let env: Env;

function makeEnv(beforeRun?: (sql: string) => void): Env {
  return {
    DB: d1(db, beforeRun),
    KV: kv.ns,
    R2: { put: vi.fn(async () => null) } as unknown as R2Bucket,
    EMAIL: { send: emailSend } as unknown as SendEmail,
    ENV: "dev",
  } as unknown as Env;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  db = openDb();
  kv = fakeKv();
  emailSend = vi.fn(async () => {});
  env = makeEnv();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

function at(offsetMs: number): void {
  vi.setSystemTime(T0 + offsetMs);
}

async function send(body: object, key: string | null = KEY) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  const req = new Request("https://worker.test/api/v1/emails", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const res = await handleEmailSend(req, env, API_KEY);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function rows() {
  return db
    .prepare(`SELECT id, status, idempotency_key, idempotency_hash, created_at FROM outbound_messages ORDER BY created_at, id`)
    .all() as Array<{
    id: string;
    status: string;
    idempotency_key: string | null;
    idempotency_hash: string | null;
    created_at: number;
  }>;
}

function insertRow(id: string, opts: { status: string; createdAt: number; hash: string | null; key?: string | null }) {
  db.prepare(
    `INSERT INTO outbound_messages (id, owner_id, idempotency_key, idempotency_hash, status, request_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6)`,
  ).run(id, USER, opts.key === undefined ? KEY : opts.key, opts.hash, opts.status, opts.createdAt);
}

describe("Idempotency-Key on POST /emails (Resend semantics)", () => {
  test("same key + same payload within 24 h replays the original id without sending", async () => {
    const first = await send(BODY);
    expect(first.status).toBe(200);
    const id = first.json.id;

    at(1 * HOUR);
    expect(await send(BODY)).toEqual({ status: 200, json: { id } });

    // D1 fallback (KV miss) also replays, and payload key order is irrelevant.
    kv.store.clear();
    at(23 * HOUR);
    const reordered = { text: BODY.text, subject: BODY.subject, to: BODY.to, from: BODY.from };
    expect(await send(reordered)).toEqual({ status: 200, json: { id } });

    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });

  test("same key after 24 h reserves and sends a new message", async () => {
    const first = await send(BODY);
    at(IDEMPOTENCY_WINDOW_MS + 1000);
    const second = await send(BODY);

    expect(second.status).toBe(200);
    expect(second.json.id).not.toBe(first.json.id);
    expect(emailSend).toHaveBeenCalledTimes(2);
    const [old, fresh] = rows();
    expect(old).toMatchObject({ id: first.json.id, idempotency_key: null });
    expect(fresh).toMatchObject({ id: second.json.id, idempotency_key: KEY, status: "sent" });
  });

  test("a different payload after 24 h is a new send, not a 409", async () => {
    await send(BODY);
    at(25 * HOUR);
    const second = await send({ ...BODY, subject: "Order #1 (restored backup)" });
    expect(second.status).toBe(200);
    expect(emailSend).toHaveBeenCalledTimes(2);
  });

  test("a KV entry that outlives the window (edge cache lag) is ignored", async () => {
    const first = await send(BODY);
    at(IDEMPOTENCY_WINDOW_MS + 1000);
    // Simulate the entry still being readable past its TTL.
    kv.store.set(idempotencyCacheKey(USER, KEY), { value: kv.puts[0]!.value, expiresAt: null });
    const second = await send(BODY);
    expect(second.json.id).not.toBe(first.json.id);
    expect(emailSend).toHaveBeenCalledTimes(2);
  });

  test("same key within 24 h with a different payload is 409 invalid_idempotent_request", async () => {
    await send(BODY);
    const changed = { ...BODY, text: "Different body." };

    at(2 * HOUR);
    const viaKv = await send(changed);
    expect(viaKv.status).toBe(409);
    expect(viaKv.json).toMatchObject({ name: "invalid_idempotent_request", statusCode: 409 });

    kv.store.clear();
    const viaD1 = await send(changed);
    expect(viaD1.status).toBe(409);
    expect(viaD1.json).toMatchObject({ name: "invalid_idempotent_request" });

    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });

  test("a failed attempt releases the key so a retry re-sends", async () => {
    emailSend.mockRejectedValueOnce(new Error("upstream 451"));
    const failed = await send(BODY);
    expect(failed.status).toBe(500);
    expect(kv.puts).toHaveLength(0);

    at(60 * 1000);
    const retry = await send(BODY);
    expect(retry.status).toBe(200);
    expect(retry.json.id).not.toBe(rows()[0]!.id);
    expect(emailSend).toHaveBeenCalledTimes(2);
    expect(rows()).toMatchObject([
      { status: "failed", idempotency_key: null },
      { id: retry.json.id, status: "sent", idempotency_key: KEY },
    ]);
  });

  test("an in-flight attempt replays its id but is not cached in KV", async () => {
    insertRow("o_inflight", { status: "sending", createdAt: T0, hash: await requestFingerprint(BODY) });
    at(5 * 1000);
    expect(await send(BODY)).toEqual({ status: 200, json: { id: "o_inflight" } });
    expect(kv.puts).toHaveLength(0);
    expect(emailSend).not.toHaveBeenCalled();
  });

  test("rows and KV entries from before migration 0008 match any payload", async () => {
    insertRow("o_legacy", { status: "sent", createdAt: T0 - HOUR, hash: null });
    const changed = { ...BODY, text: "anything" };
    expect(await send(changed)).toEqual({ status: 200, json: { id: "o_legacy" } });
    // The re-cached entry keeps the row's (absent) fingerprint, so KV keeps
    // answering exactly like D1 for yet another payload.
    expect(JSON.parse(kv.puts.at(-1)!.value)).toMatchObject({ id: "o_legacy", hash: null });
    expect(await send({ ...BODY, text: "something else" })).toEqual({
      status: 200,
      json: { id: "o_legacy" },
    });

    kv.store.clear();
    kv.store.set(idempotencyCacheKey(USER, KEY), { value: "o_legacy_kv", expiresAt: null });
    expect(await send(changed)).toEqual({ status: 200, json: { id: "o_legacy_kv" } });
    expect(emailSend).not.toHaveBeenCalled();
  });

  test("KV TTL is the remainder of the window, and skipped below 60 s", async () => {
    const first = await send(BODY);
    expect(kv.puts.at(-1)!.ttl).toBe(24 * 60 * 60);
    expect(JSON.parse(kv.puts.at(-1)!.value)).toEqual({
      id: first.json.id,
      hash: await requestFingerprint(BODY),
      created_at: T0,
    });

    kv.store.clear();
    at(23 * HOUR);
    await send(BODY);
    expect(kv.puts.at(-1)!.ttl).toBe(60 * 60);

    kv.store.clear();
    const putsBefore = kv.puts.length;
    at(IDEMPOTENCY_WINDOW_MS - 30 * 1000);
    expect(await send(BODY)).toEqual({ status: 200, json: { id: first.json.id } });
    expect(kv.puts).toHaveLength(putsBefore);
  });

  test("a concurrent duplicate that loses the reservation race is answered from the winner", async () => {
    const hash = await requestFingerprint(BODY);
    let raced = false;
    const race = (winnerHash: string) => (sql: string) => {
      if (!raced && sql.includes("INSERT INTO outbound_messages")) {
        raced = true;
        insertRow("o_winner", { status: "sending", createdAt: Date.now(), hash: winnerHash });
      }
    };

    env = makeEnv(race(hash));
    expect(await send(BODY)).toEqual({ status: 200, json: { id: "o_winner" } });

    db.prepare(`DELETE FROM outbound_messages`).run();
    raced = false;
    env = makeEnv(race("someone-else"));
    const lost = await send(BODY);
    expect(lost.status).toBe(409);
    expect(lost.json).toMatchObject({ name: "invalid_idempotent_request" });
    expect(emailSend).not.toHaveBeenCalled();
  });

  test("requests without a key are never deduplicated", async () => {
    await send(BODY, null);
    await send(BODY, null);
    expect(emailSend).toHaveBeenCalledTimes(2);
    expect(rows().every((r) => r.idempotency_key === null && r.idempotency_hash === null)).toBe(true);
  });
});

describe("resolveReservationConflict", () => {
  test("ignores rows outside the window", async () => {
    insertRow("o_old", { status: "sent", createdAt: T0 - 25 * HOUR, hash: "h" });
    expect(await resolveReservationConflict(env, USER, KEY, "h", T0)).toBeNull();
  });
});

describe("releaseExpiredIdempotencyKeys (cron sweep)", () => {
  test("nulls only keys older than 24 h, via the partial index", async () => {
    insertRow("o_expired", { status: "sent", createdAt: T0 - 25 * HOUR, hash: "a", key: "k-old" });
    insertRow("o_live", { status: "sent", createdAt: T0 - 1 * HOUR, hash: "b", key: "k-live" });
    insertRow("o_unkeyed", { status: "sent", createdAt: T0 - 30 * HOUR, hash: null, key: null });

    expect(await releaseExpiredIdempotencyKeys(env, T0)).toBe(1);
    const keys = Object.fromEntries(rows().map((r) => [r.id, r.idempotency_key]));
    expect(keys).toEqual({ o_unkeyed: null, o_expired: null, o_live: "k-live" });

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM outbound_messages
         WHERE idempotency_key IS NOT NULL AND created_at <= ?1 LIMIT ?2`,
      )
      .all(T0, 500) as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_outbound_idem_created");
  });
});

describe("idempotency helpers", () => {
  test("canonicalJson sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}',
    );
    // An own `__proto__` key from JSON.parse is kept, not swallowed.
    expect(canonicalJson(JSON.parse('{"b":2,"__proto__":{"x":1},"a":3}'))).toBe(
      '{"__proto__":{"x":1},"a":3,"b":2}',
    );
  });

  test("requestFingerprint is a stable hex SHA-256 that changes with the payload", async () => {
    const a = await requestFingerprint({ x: 1, y: [1, 2] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await requestFingerprint({ y: [1, 2], x: 1 })).toBe(a);
    expect(await requestFingerprint({ x: 1, y: [2, 1] })).not.toBe(a);
  });

  test("remainingWindowTtl counts down from 24 h and clamps below 60 s", () => {
    expect(remainingWindowTtl(T0, T0)).toBe(86400);
    expect(remainingWindowTtl(T0, T0 + 23 * HOUR + 500)).toBe(3599);
    expect(remainingWindowTtl(T0, T0 + IDEMPOTENCY_WINDOW_MS - 60_000)).toBe(60);
    expect(remainingWindowTtl(T0, T0 + IDEMPOTENCY_WINDOW_MS - 59_999)).toBeNull();
    expect(remainingWindowTtl(T0, T0 + IDEMPOTENCY_WINDOW_MS + 1)).toBeNull();
  });

  test("decodeCacheEntry reads JSON entries and legacy bare ids", () => {
    expect(decodeCacheEntry('{"id":"o_1","hash":"h","created_at":5}')).toEqual({
      id: "o_1",
      hash: "h",
      created_at: 5,
    });
    expect(decodeCacheEntry("o_legacy")).toEqual({ id: "o_legacy", hash: null, created_at: null });
    expect(decodeCacheEntry("{not json")).toBeNull();
  });
});
