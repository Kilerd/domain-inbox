// Inbound rules: a small, explicit matcher with flag actions. Evaluation lives
// in email/rules.ts; this module is the owner-scoped CRUD surface.

import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";

export interface RuleMatch {
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
}

export interface RuleActions {
  star?: boolean;
  archive?: boolean;
  trash?: boolean;
  spam?: boolean;
  read?: boolean;
}

const MATCH_KEYS = new Set(["from", "to", "subject", "hasAttachment"]);
const ACTION_KEYS = new Set(["star", "archive", "trash", "spam", "read"]);

interface RuleRow {
  id: string;
  owner_id: string;
  name: string;
  enabled: number;
  priority: number;
  match_json: string;
  actions_json: string;
  created_at: number;
  updated_at: number;
}

function shape(r: RuleRow) {
  return {
    object: "rule",
    id: r.id,
    name: r.name,
    enabled: Boolean(r.enabled),
    priority: r.priority,
    match: JSON.parse(r.match_json) as RuleMatch,
    actions: JSON.parse(r.actions_json) as RuleActions,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

export function parseMatch(raw: unknown): RuleMatch | Response {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return httpError.validation("match must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const match: RuleMatch = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!MATCH_KEYS.has(k)) return httpError.validation(`unknown match field: ${k}`);
    if (k === "hasAttachment") {
      if (typeof v !== "boolean") return httpError.validation("match.hasAttachment must be a boolean");
      match.hasAttachment = v;
    } else {
      if (typeof v !== "string") return httpError.validation(`match.${k} must be a string`);
      const trimmed = v.trim();
      if (trimmed.length > 200) return httpError.validation(`match.${k} is too long`);
      if (trimmed) match[k as "from" | "to" | "subject"] = trimmed;
    }
  }
  if (
    match.from === undefined &&
    match.to === undefined &&
    match.subject === undefined &&
    match.hasAttachment === undefined
  ) {
    return httpError.validation("match must contain at least one condition");
  }
  return match;
}

export function parseActions(raw: unknown): RuleActions | Response {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return httpError.validation("actions must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const actions: RuleActions = {};
  let on = false;
  for (const [k, v] of Object.entries(obj)) {
    if (!ACTION_KEYS.has(k)) return httpError.validation(`unknown action: ${k}`);
    if (typeof v !== "boolean") return httpError.validation(`actions.${k} must be a boolean`);
    if (v) on = true;
    actions[k as keyof RuleActions] = v;
  }
  if (!on) return httpError.validation("actions must enable at least one flag");
  return actions;
}

function parsePriority(raw: unknown): number | Response {
  if (raw === undefined) return 100;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 1000) {
    return httpError.validation("priority must be an integer between 0 and 1000");
  }
  return raw;
}

export async function handleRules(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1\/rules/, "");

  if ((path === "" || path === "/") && req.method === "GET") return listRules(env, user);
  if ((path === "" || path === "/") && req.method === "POST") return createRule(req, env, user);

  const m = path.match(/^\/([^/]+)$/);
  if (m && req.method === "GET") return getRule(env, user, m[1]!);
  if (m && req.method === "PATCH") return patchRule(req, env, user, m[1]!);
  if (m && req.method === "DELETE") return deleteRule(env, user, m[1]!);

  return httpError.notFound(`rules route ${path} not found`);
}

async function listRules(env: Env, user: AuthUser): Promise<Response> {
  const res = await env.DB
    .prepare(
      `SELECT id, owner_id, name, enabled, priority, match_json, actions_json,
              created_at, updated_at
       FROM email_rules WHERE owner_id = ?1
       ORDER BY priority, created_at`,
    )
    .bind(user.id)
    .all<RuleRow>();
  return Response.json({ object: "list", data: (res.results ?? []).map(shape) });
}

async function getRule(env: Env, user: AuthUser, id: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, owner_id, name, enabled, priority, match_json, actions_json,
              created_at, updated_at
       FROM email_rules WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<RuleRow>();
  if (!row) return httpError.notFound(`rule ${id} not found`);
  return Response.json(shape(row));
}

async function createRule(req: Request, env: Env, user: AuthUser): Promise<Response> {
  let body: {
    name?: unknown;
    enabled?: unknown;
    priority?: unknown;
    match?: unknown;
    actions?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }

  const match = parseMatch(body.match);
  if (match instanceof Response) return match;
  const actions = parseActions(body.actions);
  if (actions instanceof Response) return actions;
  const priority = parsePriority(body.priority);
  if (priority instanceof Response) return priority;

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 100)
      : "Rule";
  const enabled = body.enabled === false ? 0 : 1;
  const id = newId.rule();
  const now = Date.now();

  await env.DB
    .prepare(
      `INSERT INTO email_rules
         (id, owner_id, name, enabled, priority, match_json, actions_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
    .bind(
      id,
      user.id,
      name,
      enabled,
      priority,
      JSON.stringify(match),
      JSON.stringify(actions),
      now,
    )
    .run();

  const row = await env.DB
    .prepare(
      `SELECT id, owner_id, name, enabled, priority, match_json, actions_json,
              created_at, updated_at
       FROM email_rules WHERE id = ?1`,
    )
    .bind(id)
    .first<RuleRow>();
  return Response.json(shape(row!), { status: 201 });
}

async function patchRule(
  req: Request,
  env: Env,
  user: AuthUser,
  id: string,
): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, owner_id, name, enabled, priority, match_json, actions_json,
              created_at, updated_at
       FROM email_rules WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, user.id)
    .first<RuleRow>();
  if (!row) return httpError.notFound(`rule ${id} not found`);

  let body: {
    name?: unknown;
    enabled?: unknown;
    priority?: unknown;
    match?: unknown;
    actions?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 100)
      : row.name;
  const enabled =
    typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : row.enabled;
  const priority =
    body.priority === undefined ? row.priority : parsePriority(body.priority);
  if (priority instanceof Response) return priority;

  let match = JSON.parse(row.match_json) as RuleMatch;
  if (body.match !== undefined) {
    const parsed = parseMatch(body.match);
    if (parsed instanceof Response) return parsed;
    match = parsed;
  }
  let actions = JSON.parse(row.actions_json) as RuleActions;
  if (body.actions !== undefined) {
    const parsed = parseActions(body.actions);
    if (parsed instanceof Response) return parsed;
    actions = parsed;
  }

  const now = Date.now();
  await env.DB
    .prepare(
      `UPDATE email_rules
       SET name = ?2, enabled = ?3, priority = ?4, match_json = ?5,
           actions_json = ?6, updated_at = ?7
       WHERE id = ?1`,
    )
    .bind(id, name, enabled, priority, JSON.stringify(match), JSON.stringify(actions), now)
    .run();

  const updated = await env.DB
    .prepare(
      `SELECT id, owner_id, name, enabled, priority, match_json, actions_json,
              created_at, updated_at
       FROM email_rules WHERE id = ?1`,
    )
    .bind(id)
    .first<RuleRow>();
  return Response.json(shape(updated!));
}

async function deleteRule(env: Env, user: AuthUser, id: string): Promise<Response> {
  const res = await env.DB
    .prepare(`DELETE FROM email_rules WHERE id = ?1 AND owner_id = ?2`)
    .bind(id, user.id)
    .run();
  if (!res.meta.changes) return httpError.notFound(`rule ${id} not found`);
  return Response.json({ object: "rule", id, deleted: true });
}
