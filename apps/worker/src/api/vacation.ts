// Owner-scoped vacation responder settings. The send/guard logic lives in
// email/vacation.ts.

import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";

interface VacationRow {
  owner_id: string;
  enabled: number;
  subject: string | null;
  body_text: string;
  start_at: number | null;
  end_at: number | null;
  updated_at: number;
}

function shape(row: VacationRow | null) {
  return {
    object: "vacation",
    enabled: Boolean(row?.enabled),
    subject: row?.subject ?? null,
    body_text: row?.body_text ?? "",
    start_at: row?.start_at ? new Date(row.start_at).toISOString() : null,
    end_at: row?.end_at ? new Date(row.end_at).toISOString() : null,
    updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function parseTime(raw: unknown, field: string): number | null | Response {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return httpError.validation(`${field} must be an ISO8601 date`);
  return ts;
}

export async function handleVacation(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
): Promise<Response> {
  if (url.pathname !== "/api/v1/vacation") {
    return httpError.notFound(`vacation route ${url.pathname} not found`);
  }

  if (req.method === "GET") {
    const row = await env.DB
      .prepare(
        `SELECT owner_id, enabled, subject, body_text, start_at, end_at, updated_at
         FROM vacation_responders WHERE owner_id = ?1`,
      )
      .bind(user.id)
      .first<VacationRow>();
    return Response.json(shape(row ?? null));
  }

  if (req.method !== "PUT" && req.method !== "POST") {
    return httpError.notFound(`vacation route ${url.pathname} not found`);
  }

  let body: {
    enabled?: unknown;
    subject?: unknown;
    body_text?: unknown;
    start_at?: unknown;
    end_at?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError.badRequest("request body must be JSON");
  }

  const enabled = body.enabled === true;
  const subject =
    typeof body.subject === "string" && body.subject.trim()
      ? body.subject.trim().slice(0, 200)
      : null;
  const bodyText = typeof body.body_text === "string" ? body.body_text : "";
  if (bodyText.length > 20_000) {
    return httpError.validation("body_text is too long (max 20000 characters)");
  }
  if (enabled && !bodyText.trim()) {
    return httpError.validation("body_text is required when auto-reply is enabled");
  }

  const startAt = parseTime(body.start_at, "start_at");
  if (startAt instanceof Response) return startAt;
  const endAt = parseTime(body.end_at, "end_at");
  if (endAt instanceof Response) return endAt;
  if (startAt !== null && endAt !== null && startAt >= endAt) {
    return httpError.validation("start_at must be before end_at");
  }

  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO vacation_responders
         (owner_id, enabled, subject, body_text, start_at, end_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(owner_id) DO UPDATE SET
         enabled = excluded.enabled,
         subject = excluded.subject,
         body_text = excluded.body_text,
         start_at = excluded.start_at,
         end_at = excluded.end_at,
         updated_at = excluded.updated_at`,
    )
    .bind(user.id, enabled ? 1 : 0, subject, bodyText, startAt, endAt, now)
    .run();

  const row = await env.DB
    .prepare(
      `SELECT owner_id, enabled, subject, body_text, start_at, end_at, updated_at
       FROM vacation_responders WHERE owner_id = ?1`,
    )
    .bind(user.id)
    .first<VacationRow>();
  return Response.json(shape(row ?? null));
}
