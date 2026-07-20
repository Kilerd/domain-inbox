import type { Env } from "../env";
import { httpError } from "../http";

const TOKEN_PREFIX = "re_live_";
const PREFIX_LEN = TOKEN_PREFIX.length + 4; // displayed prefix: "re_live_XXXX"

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export interface ApiKeyAuth {
  user_id: string;
  key_id: string;
  scopes: string[];
  domain_scope: string[] | null;
}

export type ApiKeyResult = { kind: "ok"; auth: ApiKeyAuth } | { kind: "error"; response: Response };

interface CachedKey {
  id: string;
  owner_id: string;
  hash: string;
  scopes: string[];
  domain_scope: string[] | null;
  revoked: boolean;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(): string {
  // Rejection-sample so every base62 character is uniform (bytes 248-255
  // would otherwise bias toward the first 8 characters of the alphabet).
  let s = "";
  while (s.length < 22) {
    const rnd = new Uint8Array(32);
    crypto.getRandomValues(rnd);
    for (const b of rnd) {
      if (s.length >= 22) break;
      if (b < 248) s += BASE62[b % 62];
    }
  }
  return TOKEN_PREFIX + s;
}

export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LEN);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authenticateApiKey(req: Request, env: Env): Promise<ApiKeyResult> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { kind: "error", response: httpError.missingApiKey() };
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token.startsWith(TOKEN_PREFIX) || token.length < PREFIX_LEN + 6) {
    return { kind: "error", response: httpError.unauthorized() };
  }
  const prefix = tokenPrefix(token);
  const hash = await sha256Hex(token);

  let row: CachedKey | null = await env.KV.get<CachedKey>(`apikey:${prefix}`, "json");
  if (!row) {
    const dbRow = await env.DB
      .prepare(
        `SELECT id, owner_id, key_hash, scopes_json, domain_scope_json, revoked_at
         FROM api_keys WHERE prefix = ?1`,
      )
      .bind(prefix)
      .first<{
        id: string;
        owner_id: string;
        key_hash: string;
        scopes_json: string;
        domain_scope_json: string | null;
        revoked_at: number | null;
      }>();
    if (!dbRow) {
      return { kind: "error", response: httpError.unauthorized() };
    }
    row = {
      id: dbRow.id,
      owner_id: dbRow.owner_id,
      hash: dbRow.key_hash,
      scopes: JSON.parse(dbRow.scopes_json) as string[],
      domain_scope: dbRow.domain_scope_json ? (JSON.parse(dbRow.domain_scope_json) as string[]) : null,
      revoked: dbRow.revoked_at != null,
    };
    await env.KV.put(`apikey:${prefix}`, JSON.stringify(row), { expirationTtl: 300 });
  }

  if (row.revoked) {
    return { kind: "error", response: httpError.unauthorized("API key has been revoked") };
  }
  if (!timingSafeEqual(row.hash, hash)) {
    return { kind: "error", response: httpError.unauthorized() };
  }

  // Fire-and-forget update of last_used_at.
  env.DB
    .prepare(`UPDATE api_keys SET last_used_at = ?2 WHERE id = ?1`)
    .bind(row.id, Date.now())
    .run()
    .catch(() => {});

  return {
    kind: "ok",
    auth: {
      user_id: row.owner_id,
      key_id: row.id,
      scopes: row.scopes,
      domain_scope: row.domain_scope,
    },
  };
}
