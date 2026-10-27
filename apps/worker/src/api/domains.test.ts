import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import { handleDomains } from "./domains";

const USER: AuthUser = { id: "u_1", user_id: "u_1", email: "u@example.test", name: "U", role: "owner", is_new: false };

let db: DatabaseSyncType;
let env: Env;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockCf(zoneStatus = "active", routingEnabled = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("https://cloudflare-dns.com/")) {
        return json({ Answer: [] });
      }
      if (url.includes("/zones?name=")) {
        return json({
          success: true,
          result: [{ id: "z1", name: "example.test", status: zoneStatus }],
        });
      }
      if (url.endsWith("/email/routing") && !init?.method) {
        return json({ success: true, result: { enabled: routingEnabled } });
      }
      if (url.endsWith("/email/routing/enable")) {
        return json({ success: true, result: {} });
      }
      if (url.includes("/rules/catch_all")) {
        return json({ success: true, result: {} });
      }
      return json(
        { success: false, errors: [{ code: 999, message: `unexpected ${url}` }] },
        404,
      );
    }),
  );
}

beforeEach(() => {
  db = openDb();
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,created_at)
      VALUES ('u_1','u@example.test','U','magic_link','owner',0);
    INSERT INTO domains (id,owner_id,domain,verification_status,created_at)
      VALUES ('d_1','u_1','example.test','pending',0);
  `);
  env = { DB: d1(db) } as unknown as Env;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
});

async function post(path: string) {
  const req = new Request(`https://worker.test${path}`, { method: "POST" });
  const res = await handleDomains(new URL(req.url), req, env, USER);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const req = new Request(`https://worker.test${path}`);
  const res = await handleDomains(new URL(req.url), req, env, USER);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("one-click domain onboarding", () => {
  it("runs zone, routing, catch-all and database steps", async () => {
    env = { ...env, CLOUDFLARE_API_TOKEN: "tok", WORKER_NAME: "domain-inbox-dev" };
    mockCf("active", false);

    const { status, body } = await post("/api/v1/domains/d_1/auto-configure");
    expect(status).toBe(200);
    expect(body.auto_configured).toBe(true);
    expect(body.auto_config_steps).toHaveLength(4);
    expect(
      (body.auto_config_steps as Array<{ step: string; ok: boolean }>).map((s) => s.step),
    ).toEqual(["zone", "routing", "catch-all", "database"]);

    const row = db
      .prepare(`SELECT email_routing_rule_id FROM domains WHERE id='d_1'`)
      .get() as { email_routing_rule_id: string | null };
    expect(row.email_routing_rule_id).toBe("catch-all");
  });

  it("skips enabling routing when it is already on", async () => {
    env = { ...env, CLOUDFLARE_API_TOKEN: "tok", WORKER_NAME: "worker" };
    mockCf("active", true);
    const { body } = await post("/api/v1/domains/d_1/auto-configure");
    expect(body.auto_configured).toBe(true);
    expect(
      (body.auto_config_steps as Array<{ step: string; detail?: string }>).find(
        (s) => s.step === "routing",
      )?.detail,
    ).toBe("already enabled");
  });

  it("reports an inactive zone instead of pretending success", async () => {
    env = { ...env, CLOUDFLARE_API_TOKEN: "tok", WORKER_NAME: "worker" };
    mockCf("pending", false);
    const { status, body } = await post("/api/v1/domains/d_1/auto-configure");
    expect(status).toBe(200);
    expect(body.auto_configured).toBe(false);
    const steps = body.auto_config_steps as Array<{ step: string; ok: boolean; detail?: string }>;
    expect(steps[0]).toMatchObject({ step: "zone", ok: false });
    expect(steps[0]!.detail).toContain("pending");
  });

  it("returns 503 when the API token is not configured", async () => {
    const { status } = await post("/api/v1/domains/d_1/auto-configure");
    expect(status).toBe(503);
  });

  it("requires both the token and the worker name", async () => {
    env = { ...env, CLOUDFLARE_API_TOKEN: "tok" };
    expect((await post("/api/v1/domains/d_1/auto-configure")).status).toBe(503);
    expect((await get("/api/v1/domains/capabilities")).body.auto_config).toEqual({
      available: false,
      worker_name: null,
    });
  });

  it("reports capability availability", async () => {
    expect((await get("/api/v1/domains/capabilities")).body.auto_config).toEqual({
      available: false,
      worker_name: null,
    });
    env = { ...env, CLOUDFLARE_API_TOKEN: "tok", WORKER_NAME: "worker" };
    expect((await get("/api/v1/domains/capabilities")).body.auto_config).toEqual({
      available: true,
      worker_name: "worker",
    });
  });
});
