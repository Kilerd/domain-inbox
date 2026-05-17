// Suppressions management.
//
// Rows are auto-inserted by the bounce ingest path (reason='hard_bounce' or
// 'complaint'), and can also be added manually here (reason='manual'). Sends
// hit a pre-flight check that fails fast when any envelope recipient is
// suppressed — this is enforced by suppressionHits() consumed from emails.ts.

import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";
import { domainOf } from "../utils/address";

interface SuppressionRow {
  id: string;
  email: string;
  reason: string;
  source_outbound_id: string | null;
  created_at: number;
}

export async function handleSuppressions(
  url: URL,
  req: Request,
  env: Env,
  user: { id: string },
): Promise<Response> {
  const idMatch = url.pathname.match(/^\/api\/v1\/suppressions\/([^/]+)$/);

  if (url.pathname === "/api/v1/suppressions" && req.method === "GET") {
    return listSuppressions(url, env, user);
  }
  if (url.pathname === "/api/v1/suppressions" && req.method === "POST") {
    return addSuppression(req, env, user);
  }
  if (idMatch && req.method === "DELETE") {
    return deleteSuppression(env, user, idMatch[1]!);
  }
  return httpError.notFound(`route ${url.pathname} does not exist`);
}

async function listSuppressions(
  url: URL,
  env: Env,
  user: { id: string },
): Promise<Response> {
  const reason = url.searchParams.get("reason");
  const search = url.searchParams.get("q");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 500);

  const filters: string[] = ["owner_id = ?1"];
  const binds: (string | number)[] = [user.id];
  if (reason) {
    filters.push(`reason = ?${binds.length + 1}`);
    binds.push(reason);
  }
  if (search) {
    filters.push(`email LIKE ?${binds.length + 1}`);
    binds.push(`%${search.toLowerCase()}%`);
  }

  const rows = await env.DB
    .prepare(
      `SELECT id, email, reason, source_outbound_id, created_at
       FROM suppressions
       WHERE ${filters.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    )
    .bind(...binds)
    .all<SuppressionRow>();

  return Response.json({
    object: "list",
    data: rows.results.map((r) => ({
      id: r.id,
      email: r.email,
      reason: r.reason,
      source_outbound_id: r.source_outbound_id,
      created_at: new Date(r.created_at).toISOString(),
    })),
  });
}

async function addSuppression(
  req: Request,
  env: Env,
  user: { id: string },
): Promise<Response> {
  let body: { email?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  if (typeof body.email !== "string" || !body.email.trim()) {
    return httpError.validation("`email` is required");
  }
  const email = body.email.toLowerCase().trim();
  if (!domainOf(email)) {
    return httpError.validation("`email` must be a valid address");
  }
  const reason =
    typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "manual";

  const id = newId.suppression();
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO suppressions (id, owner_id, email, reason, source_outbound_id, created_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5)
       ON CONFLICT(owner_id, email) DO NOTHING`,
    )
    .bind(id, user.id, email, reason, now)
    .run();
  const row = await env.DB
    .prepare(
      `SELECT id, email, reason, source_outbound_id, created_at
       FROM suppressions WHERE owner_id = ?1 AND email = ?2`,
    )
    .bind(user.id, email)
    .first<SuppressionRow>();
  if (!row) return httpError.internal("failed to read back suppression");
  return Response.json({
    id: row.id,
    email: row.email,
    reason: row.reason,
    source_outbound_id: row.source_outbound_id,
    created_at: new Date(row.created_at).toISOString(),
  });
}

async function deleteSuppression(
  env: Env,
  user: { id: string },
  id: string,
): Promise<Response> {
  const row = await env.DB
    .prepare(`SELECT id FROM suppressions WHERE id = ?1 AND owner_id = ?2`)
    .bind(id, user.id)
    .first<{ id: string }>();
  if (!row) return httpError.notFound(`suppression ${id} not found`);
  await env.DB.prepare(`DELETE FROM suppressions WHERE id = ?1`).bind(id).run();
  return Response.json({ id, deleted: true });
}

/**
 * Pre-flight suppression check for the send path. Returns the addresses
 * (lowercased) that should be blocked from receiving the send.
 */
export async function suppressionHits(
  env: Env,
  ownerId: string,
  recipients: string[],
): Promise<string[]> {
  if (recipients.length === 0) return [];
  const lowered = recipients.map((r) => r.toLowerCase());
  const placeholders = lowered.map((_, i) => `?${i + 2}`).join(",");
  const rows = await env.DB
    .prepare(
      `SELECT email FROM suppressions
       WHERE owner_id = ?1 AND email IN (${placeholders})`,
    )
    .bind(ownerId, ...lowered)
    .all<{ email: string }>();
  return rows.results.map((r) => r.email);
}
