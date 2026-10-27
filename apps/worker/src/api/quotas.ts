// Per-owner outbound quota. D1 is the counter: the UPSERT is atomic, so
// concurrent sends cannot race past the cap the way a KV read-modify-write
// would. Scheduled sends are counted when they are accepted, not when the
// cron fires, so a caller cannot queue an unbounded amount of work.

import type { Env } from "../env";

export const DEFAULT_SEND_DAILY_LIMIT = 1000;

export function sendDailyLimit(env: Env): number {
  const raw = env.SEND_DAILY_LIMIT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SEND_DAILY_LIMIT;
}

/** UTC day key, e.g. 2026-10-27. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Reserve one send for `ownerId`. False when the owner is already at the
 * daily cap; the counter is not incremented past the limit.
 */
export async function consumeSendQuota(
  env: Env,
  ownerId: string,
  now = Date.now(),
): Promise<boolean> {
  const limit = sendDailyLimit(env);
  if (limit <= 0) return false;

  const row = await env.DB
    .prepare(
      `INSERT INTO send_usage (owner_id, day, count) VALUES (?1, ?2, 1)
       ON CONFLICT(owner_id, day) DO UPDATE SET count = send_usage.count + 1
       WHERE send_usage.count < ?3
       RETURNING count`,
    )
    .bind(ownerId, utcDay(now), limit)
    .first<{ count: number }>();
  return row !== null;
}
