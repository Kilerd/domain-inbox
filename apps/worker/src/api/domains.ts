import type { AuthUser } from "../auth";
import {
  enableRouting,
  getZoneId,
  setCatchAllToWorker,
} from "../cf/email_routing";
import type { Env } from "../env";
import { httpError } from "../http";
import { newId } from "../ids";
import { log } from "../utils/log";
import { fanoutEvent } from "../webhooks/dispatch";
import {
  discoverRecords,
  expectedRecords,
  inboundReady,
  outboundReady,
  type ExpectedRecord,
} from "./dns";

interface DomainRow {
  id: string;
  owner_id: string;
  domain: string;
  verification_status: string;
  catch_all_enabled: number;
  created_at: number;
  verified_at: number | null;
}

function shape(row: DomainRow, records: ExpectedRecord[]) {
  return {
    object: "domain",
    id: row.id,
    name: row.domain,
    status: row.verification_status,
    receive_status: inboundReady(records) ? "verified" : "pending",
    send_status: outboundReady(records) ? "verified" : "pending",
    catch_all_enabled: Boolean(row.catch_all_enabled),
    created_at: new Date(row.created_at).toISOString(),
    verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    records,
  };
}

export async function handleDomains(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/v1\/domains/, "");

  if ((path === "" || path === "/") && req.method === "GET") return listDomains(env, user);
  if ((path === "" || path === "/") && req.method === "POST") return createDomain(req, env, user, ctx);

  const m = path.match(/^\/([^/]+)$/);
  if (m && req.method === "GET") return getDomain(env, user, m[1]!);
  if (m && req.method === "DELETE") return deleteDomain(env, user, m[1]!, ctx);

  const v = path.match(/^\/([^/]+)\/verify$/);
  if (v && req.method === "POST") return verifyDomain(env, user, v[1]!, ctx);

  return httpError.notFound(`domain route ${path} not found`);
}

async function listDomains(env: Env, user: AuthUser): Promise<Response> {
  const res = await env.DB
    .prepare(
      `SELECT id, owner_id, domain, verification_status, catch_all_enabled, created_at, verified_at
       FROM domains WHERE owner_id = ?1 ORDER BY created_at DESC`,
    )
    .bind(user.id)
    .all<DomainRow>();
  const rows = res.results ?? [];
  // Live-discover real DNS state for each domain in parallel. With < ~25 domains
  // this is fast (3 parallel DoH queries each, all in one Worker request).
  const discovered = await Promise.all(rows.map((r) => discoverRecords(r.domain)));
  return Response.json({
    object: "list",
    data: rows.map((r, i) => shape(r, discovered[i]!)),
  });
}

async function createDomain(
  req: Request,
  env: Env,
  user: AuthUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  let body: { name?: unknown };
  try {
    body = (await req.json()) as { name?: unknown };
  } catch {
    return httpError.badRequest("request body must be JSON");
  }
  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) {
    return httpError.badRequest("invalid domain name");
  }

  const existing = await env.DB
    .prepare("SELECT id FROM domains WHERE domain = ?1")
    .bind(name)
    .first<{ id: string }>();
  if (existing) {
    return httpError.conflict(`domain ${name} already exists`);
  }

  const id = newId.domain();
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO domains (id, owner_id, domain, verification_status, catch_all_enabled, created_at)
       VALUES (?1, ?2, ?3, 'pending', 1, ?4)`,
    )
    .bind(id, user.id, name, now)
    .run();

  // Best-effort CF Email Routing auto-config. Failures are logged but don't
  // fail the request — user can configure manually via the dashboard.
  let autoConfigured = false;
  let autoConfigError: string | null = null;
  if (env.CLOUDFLARE_API_TOKEN && env.WORKER_NAME) {
    try {
      const zoneId = await getZoneId(env.CLOUDFLARE_API_TOKEN, name);
      await enableRouting(env.CLOUDFLARE_API_TOKEN, zoneId);
      await setCatchAllToWorker(env.CLOUDFLARE_API_TOKEN, zoneId, env.WORKER_NAME);
      await env.DB
        .prepare(`UPDATE domains SET email_routing_rule_id = 'catch-all' WHERE id = ?1`)
        .bind(id)
        .run();
      autoConfigured = true;
      log.info("domain.auto_configured", { domain: name, zone_id: zoneId });
    } catch (err) {
      autoConfigError = (err as Error).message;
      log.warn("domain.auto_config_failed", { domain: name, error: autoConfigError });
    }
  }

  const row: DomainRow = {
    id,
    owner_id: user.id,
    domain: name,
    verification_status: "pending",
    catch_all_enabled: 1,
    created_at: now,
    verified_at: null,
  };
  const dispatch = fanoutEvent(env, user.id, "domain.created", {
    domain_id: id,
    name,
    auto_configured: autoConfigured,
  });
  if (ctx) ctx.waitUntil(dispatch);
  else await dispatch;
  return Response.json(
    {
      ...shape(row, expectedRecords(name)),
      auto_configured: autoConfigured,
      auto_config_error: autoConfigError,
    },
    { status: 201 },
  );
}

async function getDomain(env: Env, user: AuthUser, idOrName: string): Promise<Response> {
  const row = await fetchDomain(env, user, idOrName);
  if (!row) return httpError.notFound(`domain ${idOrName} not found`);
  const records = await discoverRecords(row.domain);
  return Response.json(shape(row, records));
}

async function deleteDomain(
  env: Env,
  user: AuthUser,
  idOrName: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const row = await fetchDomain(env, user, idOrName);
  if (!row) return httpError.notFound(`domain ${idOrName} not found`);
  await env.DB.prepare(`DELETE FROM domains WHERE id = ?1`).bind(row.id).run();
  const dispatch = fanoutEvent(env, user.id, "domain.deleted", {
    domain_id: row.id,
    name: row.domain,
  });
  if (ctx) ctx.waitUntil(dispatch);
  else await dispatch;
  return Response.json({ object: "domain", id: row.id, deleted: true });
}

async function verifyDomain(
  env: Env,
  user: AuthUser,
  idOrName: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const row = await fetchDomain(env, user, idOrName);
  if (!row) return httpError.notFound(`domain ${idOrName} not found`);

  const records = await discoverRecords(row.domain);
  const allOk = inboundReady(records);

  const newStatus = allOk ? "verified" : "pending";
  const verifiedAt = allOk ? Date.now() : null;
  await env.DB
    .prepare(
      `UPDATE domains SET verification_status = ?2, verified_at = COALESCE(?3, verified_at)
       WHERE id = ?1`,
    )
    .bind(row.id, newStatus, verifiedAt)
    .run();

  // Emit on the transition only — pending → verified is what consumers want
  // to know about; re-verifying an already-verified domain shouldn't refire.
  if (row.verification_status !== "verified" && newStatus === "verified") {
    const dispatch = fanoutEvent(env, user.id, "domain.verified", {
      domain_id: row.id,
      name: row.domain,
    });
    if (ctx) ctx.waitUntil(dispatch);
    else await dispatch;
  }

  return Response.json(
    shape(
      { ...row, verification_status: newStatus, verified_at: verifiedAt ?? row.verified_at },
      records,
    ),
  );
}

async function fetchDomain(env: Env, user: AuthUser, idOrName: string): Promise<DomainRow | null> {
  return env.DB
    .prepare(
      `SELECT id, owner_id, domain, verification_status, catch_all_enabled, created_at, verified_at
       FROM domains
       WHERE owner_id = ?1 AND (id = ?2 OR domain = ?2)
       LIMIT 1`,
    )
    .bind(user.id, idOrName)
    .first<DomainRow>();
}
