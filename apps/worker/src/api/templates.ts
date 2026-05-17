// Template storage + CRUD + lightweight Mustache-style rendering.
//
// We support flat `{{var}}` substitution. In `html` bodies, `{{var}}` is
// HTML-escaped to defend against accidental XSS via user-supplied variables;
// `{{{var}}}` (triple-brace) passes through unescaped for cases where the
// variable is *already* trusted HTML (e.g. a pre-rendered button fragment).
// `subject` and `text` get raw substitution (no escape — they aren't HTML).
//
// Send-time wiring: handleEmailSend reads `template` + `template_data` from
// the request body, fetches the row, renders, and uses the rendered output
// in place of subject/html/text. The outbound row records template_id so we
// can attribute usage later.

import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";

export interface TemplateRow {
  id: string;
  name: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  variables_schema: string | null;
  created_at: number;
  updated_at: number;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lookup(vars: Record<string, unknown>, path: string): string {
  // Support dotted paths like {{user.name}}; non-strings get JSON-stringified
  // so the template author can spot the type mismatch in the rendered output
  // rather than getting a silent `[object Object]`.
  const parts = path.trim().split(".");
  let cur: unknown = vars;
  for (const p of parts) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return "";
    }
  }
  if (cur == null) return "";
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return JSON.stringify(cur);
}

export function renderMustache(
  body: string,
  vars: Record<string, unknown>,
  escape: boolean,
): string {
  // Triple-brace first so it doesn't get caught by the double-brace pass.
  let out = body.replace(/\{\{\{([^}]+)\}\}\}/g, (_m, p1: string) => lookup(vars, p1));
  out = out.replace(/\{\{([^}]+)\}\}/g, (_m, p1: string) => {
    const v = lookup(vars, p1);
    return escape ? htmlEscape(v) : v;
  });
  return out;
}

export interface RenderedTemplate {
  subject: string | null;
  html: string | null;
  text: string | null;
}

export function renderTemplate(
  tpl: Pick<TemplateRow, "subject" | "html" | "text">,
  vars: Record<string, unknown>,
): RenderedTemplate {
  return {
    subject: tpl.subject == null ? null : renderMustache(tpl.subject, vars, false),
    html: tpl.html == null ? null : renderMustache(tpl.html, vars, true),
    text: tpl.text == null ? null : renderMustache(tpl.text, vars, false),
  };
}

export async function getTemplateById(
  env: Env,
  ownerId: string,
  id: string,
): Promise<TemplateRow | null> {
  return env.DB
    .prepare(
      `SELECT id, name, subject, html, text, variables_schema, created_at, updated_at
       FROM templates WHERE id = ?1 AND owner_id = ?2`,
    )
    .bind(id, ownerId)
    .first<TemplateRow>();
}

function serializeTemplate(t: TemplateRow): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    subject: t.subject,
    html: t.html,
    text: t.text,
    variables_schema: t.variables_schema ? JSON.parse(t.variables_schema) : null,
    created_at: new Date(t.created_at).toISOString(),
    updated_at: new Date(t.updated_at).toISOString(),
  };
}

export async function handleTemplates(
  url: URL,
  req: Request,
  env: Env,
  user: { id: string },
): Promise<Response> {
  const idMatch = url.pathname.match(/^\/api\/v1\/templates\/([^/]+)$/);
  const renderMatch = url.pathname.match(/^\/api\/v1\/templates\/([^/]+)\/render$/);

  if (url.pathname === "/api/v1/templates" && req.method === "GET") {
    return listTemplates(env, user);
  }
  if (url.pathname === "/api/v1/templates" && req.method === "POST") {
    return createTemplate(req, env, user);
  }
  if (renderMatch && req.method === "POST") {
    return previewTemplate(req, env, user, renderMatch[1]!);
  }
  if (idMatch && req.method === "GET") {
    return readTemplate(env, user, idMatch[1]!);
  }
  if (idMatch && req.method === "PATCH") {
    return updateTemplate(req, env, user, idMatch[1]!);
  }
  if (idMatch && req.method === "DELETE") {
    return deleteTemplate(env, user, idMatch[1]!);
  }
  return httpError.notFound(`route ${url.pathname} does not exist`);
}

async function listTemplates(env: Env, user: { id: string }): Promise<Response> {
  const rows = await env.DB
    .prepare(
      `SELECT id, name, subject, html, text, variables_schema, created_at, updated_at
       FROM templates WHERE owner_id = ?1 ORDER BY updated_at DESC`,
    )
    .bind(user.id)
    .all<TemplateRow>();
  return Response.json({ object: "list", data: rows.results.map(serializeTemplate) });
}

interface TemplateBody {
  name?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  variables_schema?: unknown;
}

function pickString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

async function createTemplate(
  req: Request,
  env: Env,
  user: { id: string },
): Promise<Response> {
  let body: TemplateBody;
  try {
    body = (await req.json()) as TemplateBody;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return httpError.validation("`name` is required");
  }
  const name = body.name.trim();
  const subject = pickString(body.subject);
  const html = pickString(body.html);
  const text = pickString(body.text);
  if (!html && !text) {
    return httpError.validation("one of `html` or `text` is required");
  }
  const varsSchema =
    body.variables_schema == null ? null : JSON.stringify(body.variables_schema);

  const id = newId.template();
  const now = Date.now();
  try {
    await env.DB
      .prepare(
        `INSERT INTO templates
           (id, owner_id, name, subject, html, text, variables_schema, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      )
      .bind(id, user.id, name, subject, html, text, varsSchema, now)
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return httpError.conflict(`template name "${name}" already exists`);
    }
    throw err;
  }
  const row = await getTemplateById(env, user.id, id);
  if (!row) return httpError.internal("template insert succeeded but row missing");
  return Response.json(serializeTemplate(row));
}

async function readTemplate(
  env: Env,
  user: { id: string },
  id: string,
): Promise<Response> {
  const row = await getTemplateById(env, user.id, id);
  if (!row) return httpError.notFound(`template ${id} not found`);
  return Response.json(serializeTemplate(row));
}

async function updateTemplate(
  req: Request,
  env: Env,
  user: { id: string },
  id: string,
): Promise<Response> {
  const existing = await getTemplateById(env, user.id, id);
  if (!existing) return httpError.notFound(`template ${id} not found`);
  let body: TemplateBody;
  try {
    body = (await req.json()) as TemplateBody;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name;
  const subject = body.subject === undefined ? existing.subject : pickString(body.subject);
  const html = body.html === undefined ? existing.html : pickString(body.html);
  const text = body.text === undefined ? existing.text : pickString(body.text);
  if (!html && !text) {
    return httpError.validation("at least one of `html` or `text` must remain set");
  }
  const varsSchema =
    body.variables_schema === undefined
      ? existing.variables_schema
      : body.variables_schema == null
        ? null
        : JSON.stringify(body.variables_schema);

  try {
    await env.DB
      .prepare(
        `UPDATE templates
         SET name = ?2, subject = ?3, html = ?4, text = ?5, variables_schema = ?6, updated_at = ?7
         WHERE id = ?1`,
      )
      .bind(id, name, subject, html, text, varsSchema, Date.now())
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return httpError.conflict(`template name "${name}" already exists`);
    }
    throw err;
  }
  const row = await getTemplateById(env, user.id, id);
  return Response.json(serializeTemplate(row!));
}

async function deleteTemplate(
  env: Env,
  user: { id: string },
  id: string,
): Promise<Response> {
  const row = await getTemplateById(env, user.id, id);
  if (!row) return httpError.notFound(`template ${id} not found`);
  await env.DB.prepare(`DELETE FROM templates WHERE id = ?1`).bind(id).run();
  return Response.json({ object: "template", id, deleted: true });
}

async function previewTemplate(
  req: Request,
  env: Env,
  user: { id: string },
  id: string,
): Promise<Response> {
  const row = await getTemplateById(env, user.id, id);
  if (!row) return httpError.notFound(`template ${id} not found`);
  let body: { data?: unknown };
  try {
    body = (await req.json()) as { data?: unknown };
  } catch {
    body = {};
  }
  const data =
    body.data && typeof body.data === "object"
      ? (body.data as Record<string, unknown>)
      : {};
  const rendered = renderTemplate(row, data);
  return Response.json({ template_id: id, ...rendered });
}
