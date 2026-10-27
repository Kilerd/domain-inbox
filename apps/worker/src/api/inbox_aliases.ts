import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";
import { FLAG_ARCHIVED, FLAG_AUXILIARY, FLAG_READ, FLAG_SPAM, FLAG_TRASH } from "../utils/flags";

export async function listInboxDomains(env: Env, user: AuthUser): Promise<Response> {
  // Must mirror viewClause("inbox"): archived threads don't appear in the
  // Inbox, so an unread message inside an archived thread must not keep the
  // Inbox badge lit. (Archiving a conversation doesn't mark it read.)
  const res = await env.DB
    .prepare(
      `SELECT d.id, d.domain,
              (SELECT COUNT(*) FROM threads t
                 WHERE t.owner_id = ?1 AND t.domain_id = d.id
                   AND (t.flags_bitmap & ?2) = 0
                   AND t.unread_count > 0) AS unread_count,
              (SELECT COUNT(*) FROM threads t
                 WHERE t.owner_id = ?1 AND t.domain_id = d.id
                   AND (t.flags_bitmap & ?2) = 0) AS thread_count
       FROM domains d
       WHERE d.owner_id = ?1
       ORDER BY d.created_at DESC`,
    )
    .bind(user.id, FLAG_ARCHIVED | FLAG_TRASH | FLAG_SPAM)
    .all<{ id: string; domain: string; unread_count: number; thread_count: number }>();
  return Response.json({
    object: "list",
    data: res.results ?? [],
  });
}

interface AliasListRow {
  id: string;
  domain_id: string;
  full_address: string;
  local_part: string;
  type: string;
  label: string | null;
  disabled: number;
  hidden: number;
  message_count: number;
  unread_count: number;
  last_message_at: number | null;
}

export async function listInboxAliases(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const domain = url.searchParams.get("domain");
  const includeQuiet = url.searchParams.get("include_quiet") === "true";

  // We always restrict to aliases the user owns (via the domain).
  const where: string[] = ["d.owner_id = ?"];
  const binds: unknown[] = [user.id];
  if (domain) {
    where.push("(d.id = ? OR d.domain = ?)");
    binds.push(domain, domain);
  }

  let sql = `
    SELECT a.id, a.domain_id, a.full_address, a.local_part, a.type, a.label,
           a.disabled, a.hidden, a.message_count, a.last_message_at,
           (SELECT COUNT(*) FROM messages m
             WHERE m.alias_id = a.id
               AND m.parse_status != 'duplicate'
               AND m.direction = 'inbound'
               AND (m.flags_bitmap & ${FLAG_AUXILIARY}) = 0
               AND (m.flags_bitmap & ${FLAG_READ}) = 0) AS unread_count
    FROM aliases a JOIN domains d ON d.id = a.domain_id
    WHERE ${where.join(" AND ")}`;

  if (!includeQuiet) {
    // Default Navigator view hides auto_created aliases that are obviously
    // noise: hidden=1, or zero/one messages with no recent activity.
    sql += ` AND NOT (
      a.hidden = 1
      OR (a.type = 'auto_created'
          AND a.message_count <= 1
          AND (a.last_message_at IS NULL
               OR a.last_message_at < (strftime('%s','now') * 1000) - 7*24*3600*1000))
    )`;
  }
  sql += ` ORDER BY a.last_message_at DESC NULLS LAST, a.local_part`;

  const res = await env.DB.prepare(sql).bind(...binds).all<AliasListRow>();
  return Response.json({
    object: "list",
    data: (res.results ?? []).map((a) => ({
      id: a.id,
      domain_id: a.domain_id,
      address: a.full_address,
      local_part: a.local_part,
      type: a.type,
      label: a.label,
      disabled: Boolean(a.disabled),
      hidden: Boolean(a.hidden),
      message_count: a.message_count,
      unread_count: a.unread_count,
      last_message_at: a.last_message_at,
    })),
  });
}

export async function patchAlias(req: Request, env: Env, user: AuthUser, id: string): Promise<Response> {
  let body: { label?: unknown; hidden?: unknown; disabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  // Verify ownership.
  const row = await env.DB
    .prepare(
      `SELECT a.id FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE a.id = ?1 AND d.owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<{ id: string }>();
  if (!row) return httpError.notFound(`alias ${id} not found`);

  const updates: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.label === "string" || body.label === null) {
    updates.push("label = ?");
    binds.push(body.label);
  }
  if (typeof body.hidden === "boolean") {
    updates.push("hidden = ?");
    binds.push(body.hidden ? 1 : 0);
  }
  if (typeof body.disabled === "boolean") {
    updates.push("disabled = ?");
    binds.push(body.disabled ? 1 : 0);
  }
  if (!updates.length) return httpError.validation("no editable fields supplied");
  binds.push(id);
  await env.DB
    .prepare(`UPDATE aliases SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return Response.json({ object: "alias", id, updated: true });
}

export async function deleteAlias(env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT a.id, a.type, a.message_count
       FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE a.id = ?1 AND d.owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<{ id: string; type: string; message_count: number }>();
  if (!row) return httpError.notFound(`alias ${id} not found`);
  if (row.type !== "auto_created") {
    return httpError.validation("only auto_created aliases may be deleted");
  }
  if (row.message_count > 0) {
    return httpError.validation("alias still has associated messages; hide instead");
  }
  await env.DB.prepare(`DELETE FROM aliases WHERE id = ?1`).bind(id).run();
  return Response.json({ object: "alias", id, deleted: true });
}

