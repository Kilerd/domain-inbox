// Idempotency-Key handling for POST /api/v1/emails, matching Resend: a key is
// honoured for 24 h from the original request. Inside that window a replay
// with the same payload returns the original id without sending, and a replay
// with a different payload is rejected (409 invalid_idempotent_request).
// After it, the key is free and the same value starts a new send.
//
// D1 is the source of truth: outbound_messages.idempotency_key (with
// UNIQUE(owner_id, idempotency_key) as the atomic reservation) and
// outbound_messages.idempotency_hash (request fingerprint, migration 0008).
// Because the UNIQUE constraint would otherwise block reuse forever, an
// expired key is released (nulled) on the old row before a new reservation,
// and the cron sweep releases expired keys in bulk. KV is only a read-through
// cache of successful sends whose TTL never outlives the window.

import type { Env } from "../env";

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Cloudflare KV rejects an expirationTtl below 60 s.
const KV_MIN_TTL_S = 60;
// Bound on keys released per cron run so one sweep can never be a huge write.
const SWEEP_BATCH = 500;

// Answer to a request whose key is live: the original id, or a 409.
export type IdempotentReply = { kind: "replay"; id: string } | { kind: "mismatch" };
export type IdempotencyOutcome = IdempotentReply | { kind: "proceed" };

export interface IdempotentSend {
  key: string;
  hash: string;
  createdAt: number;
}

interface CacheEntry {
  id: string;
  hash: string | null;
  created_at: number | null;
}

export function idempotencyCacheKey(userId: string, key: string): string {
  return `idem:${userId}:${key}`;
}

// JSON with object keys sorted recursively (arrays keep their order), so key
// order and whitespace in the client's payload don't change the fingerprint.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Hex SHA-256 of the canonical JSON of the request body as the client sent it.
export async function requestFingerprint(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(body)),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Seconds left in the key's window, or null when below KV's minimum TTL (then
// the entry is simply not cached; D1 still answers correctly).
export function remainingWindowTtl(createdAt: number, now: number): number | null {
  const seconds = Math.floor((createdAt + IDEMPOTENCY_WINDOW_MS - now) / 1000);
  return seconds >= KV_MIN_TTL_S ? seconds : null;
}

// KV values are `{"id","hash","created_at"}` JSON; entries written before
// migration 0008 are a bare outbound id and carry no fingerprint.
export function decodeCacheEntry(raw: string): CacheEntry | null {
  if (!raw.startsWith("{")) return { id: raw, hash: null, created_at: null };
  try {
    const v = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof v.id !== "string") return null;
    return {
      id: v.id,
      hash: typeof v.hash === "string" ? v.hash : null,
      created_at: typeof v.created_at === "number" ? v.created_at : null,
    };
  } catch {
    return null;
  }
}

// A NULL stored fingerprint (row or cache entry predating 0008) is a match.
function samePayload(stored: string | null, incoming: string): boolean {
  return stored === null || stored === incoming;
}

// `hash` is the fingerprint stored on the row (null for pre-0008 rows), so
// the cache answers exactly as D1 would.
export async function cacheIdempotentSend(
  kv: KVNamespace,
  userId: string,
  key: string,
  sent: { id: string; hash: string | null; createdAt: number },
  now: number,
): Promise<void> {
  const ttl = remainingWindowTtl(sent.createdAt, now);
  if (ttl === null) return;
  const entry: CacheEntry = { id: sent.id, hash: sent.hash, created_at: sent.createdAt };
  await kv.put(idempotencyCacheKey(userId, key), JSON.stringify(entry), {
    expirationTtl: ttl,
  });
}

// Statuses whose outcome can no longer change to `failed`; only these are
// cached, so an in-flight or scheduled attempt that later fails stays
// retryable under the same key.
const SETTLED = new Set(["sent", "delivered", "bounced", "complained", "canceled"]);

/**
 * Pre-reservation check. Returns `replay` (answer with the original id),
 * `mismatch` (409) or `proceed` (reserve a new row). On `proceed` the key has
 * been released from any row that would block the INSERT: a failed attempt
 * (so a retry re-sends) or a row older than the window (so the key can be
 * reused, as with Resend).
 */
export async function checkIdempotencyKey(
  env: Env,
  userId: string,
  key: string,
  hash: string,
  now: number,
): Promise<IdempotencyOutcome> {
  const windowStart = now - IDEMPOTENCY_WINDOW_MS;

  const cached = await env.KV.get(idempotencyCacheKey(userId, key), "text");
  const entry = cached ? decodeCacheEntry(cached) : null;
  // created_at is re-checked so KV's TTL rounding / edge caching can't extend
  // the window; legacy entries were written with an 86400 s TTL.
  if (entry && (entry.created_at === null || entry.created_at > windowStart)) {
    return samePayload(entry.hash, hash) ? { kind: "replay", id: entry.id } : { kind: "mismatch" };
  }

  const existing = await env.DB
    .prepare(
      `SELECT id, status, created_at, idempotency_hash FROM outbound_messages
       WHERE owner_id = ?1 AND idempotency_key = ?2 AND created_at > ?3`,
    )
    .bind(userId, key, windowStart)
    .first<{ id: string; status: string; created_at: number; idempotency_hash: string | null }>();
  if (existing && existing.status !== "failed") {
    if (!samePayload(existing.idempotency_hash, hash)) return { kind: "mismatch" };
    if (SETTLED.has(existing.status)) {
      await cacheIdempotentSend(
        env.KV,
        userId,
        key,
        { id: existing.id, hash: existing.idempotency_hash, createdAt: existing.created_at },
        now,
      );
    }
    return { kind: "replay", id: existing.id };
  }

  await env.DB
    .prepare(
      `UPDATE outbound_messages SET idempotency_key = NULL
       WHERE owner_id = ?1 AND idempotency_key = ?2
         AND (status = 'failed' OR created_at <= ?3)`,
    )
    .bind(userId, key, windowStart)
    .run();
  return { kind: "proceed" };
}

/**
 * The reservation INSERT lost the UNIQUE race to a concurrent request: answer
 * from the in-window winner. Null when no in-window row holds the key.
 */
export async function resolveReservationConflict(
  env: Env,
  userId: string,
  key: string,
  hash: string,
  now: number,
): Promise<IdempotentReply | null> {
  const winner = await env.DB
    .prepare(
      `SELECT id, idempotency_hash FROM outbound_messages
       WHERE owner_id = ?1 AND idempotency_key = ?2 AND created_at > ?3`,
    )
    .bind(userId, key, now - IDEMPOTENCY_WINDOW_MS)
    .first<{ id: string; idempotency_hash: string | null }>();
  if (!winner) return null;
  return samePayload(winner.idempotency_hash, hash)
    ? { kind: "replay", id: winner.id }
    : { kind: "mismatch" };
}

/**
 * Cron sweep: release keys older than the window so the UNIQUE index only
 * holds live keys. Uses the partial index from migration 0008. Returns the
 * number of rows released.
 */
export async function releaseExpiredIdempotencyKeys(env: Env, now = Date.now()): Promise<number> {
  const res = await env.DB
    .prepare(
      `UPDATE outbound_messages SET idempotency_key = NULL
       WHERE id IN (SELECT id FROM outbound_messages
                    WHERE idempotency_key IS NOT NULL AND created_at <= ?1
                    LIMIT ?2)`,
    )
    .bind(now - IDEMPOTENCY_WINDOW_MS, SWEEP_BATCH)
    .run();
  return res.meta.changes ?? 0;
}
