import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:email", () => ({
  EmailMessage: class {
    constructor(
      public from: string,
      public to: string,
      public raw: string,
    ) {}
  },
}));

import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import { handleInbox } from "./inbox";

const USER: AuthUser = { id: "u_1", email: "u@example.test", name: "U", is_new: false };

let db: DatabaseSyncType;
let env: Env;

function seed() {
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,created_at) VALUES
      ('u_1','u@example.test','U','magic_link','owner',0),
      ('u_2','x@example.test','X','magic_link','owner',0);
    INSERT INTO domains (id,owner_id,domain,verification_status,catch_all_enabled,created_at) VALUES
      ('d_1','u_1','example.test','verified',1,0),
      ('d_2','u_2','other.test','verified',1,0);
    INSERT INTO aliases (id,domain_id,local_part,full_address,type,target_user_id,created_at,message_count,last_message_at,hidden) VALUES
      ('a_1','d_1','hello','hello@example.test','explicit','u_1',0,5,0,0);
    INSERT INTO threads (id,owner_id,domain_id,subject_normalized,participants_json,last_message_at,first_message_at,message_count,unread_count,flags_bitmap) VALUES
      ('t_1','u_1','d_1','one','[]',0,0,2,2,0),
      ('t_2','u_1','d_1','two','[]',0,0,3,1,0),
      ('t_out','u_1','d_1','outbound only','[]',0,0,1,0,0),
      ('t_other','u_2','d_2','other','[]',0,0,1,1,0);
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages
      (id,thread_id,owner_id,domain_id,alias_id,rfc822_message_id,direction,subject,
       received_at,size_bytes,flags_bitmap,parse_status,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,10,?9,?10,0)
  `);
  const rows: Array<[string, string, string, string, string | null, string, string, number, string]> = [
    ["m_unread", "t_1", "u_1", "d_1", "a_1", "<u@x>", "inbound", 0, "parsed"],
    ["m_aux", "t_1", "u_1", "d_1", "a_1", "<a@x>", "inbound", 64, "parsed"],
    ["m_read", "t_2", "u_1", "d_1", "a_1", "<r@x>", "inbound", 1, "parsed"],
    ["m_dup", "t_2", "u_1", "d_1", "a_1", "<d@x>", "inbound", 0, "duplicate"],
    ["m_out", "t_2", "u_1", "d_1", "a_1", "<o@x>", "outbound", 0, "parsed"],
    ["m_out_only", "t_out", "u_1", "d_1", "a_1", "<oo@x>", "outbound", 1, "parsed"],
    ["m_other", "t_other", "u_2", "d_2", null, "<x@x>", "inbound", 0, "parsed"],
  ];
  for (const [id, thread, owner, domain, alias, msgid, dir, flags, status] of rows) {
    insertMessage.run(id, thread, owner, domain, alias, msgid, dir, id, flags, status);
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  db = openDb();
  seed();
  env = {
    DB: d1(db),
    KV: {} as unknown as KVNamespace,
    R2: {} as unknown as R2Bucket,
    ENV: "dev",
  } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

async function call(path: string, body?: unknown) {
  const req = new Request(`https://worker.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleInbox(new URL(req.url), req, env, USER);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function get(sql: string, ...args: unknown[]) {
  return db.prepare(sql).get(...(args as never[])) as Record<string, unknown>;
}

describe("alias unread is derived from messages", () => {
  it("counts only inbound, parsed, non-auxiliary, unread messages", async () => {
    const { status, json } = await call("/api/inbox/aliases?domain=d_1");
    expect(status).toBe(200);
    expect((json.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      address: "hello@example.test",
      unread_count: 1,
    });
  });
});

describe("inbox is received mail only", () => {
  it("keeps outbound-only threads out of inbox but in sent/all", async () => {
    const ids = async (view: string) => {
      const { status, json } = await call(`/api/inbox/threads?view=${view}&limit=10`);
      expect(status).toBe(200);
      return (json.threads as Array<{ id: string }>).map((t) => t.id).sort();
    };
    expect(await ids("inbox")).toEqual(["t_1", "t_2"]);
    expect(await ids("sent")).toEqual(["t_2", "t_out"]);
    expect(await ids("all")).toEqual(["t_1", "t_2", "t_out"]);
  });

  it("mirrors the inbox scope in the domain thread count", async () => {
    const { status, json } = await call("/api/inbox/domains");
    expect(status).toBe(200);
    expect((json.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      domain: "example.test",
      thread_count: 2,
    });
  });
});

describe("batch thread flags", () => {
  it("marks a chunk in one pass and recounts each thread", async () => {
    const { status, json } = await call("/api/inbox/threads/batch/flags", {
      ids: ["t_1", "t_2", "missing"],
      read: true,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ object: "list", updated: 2, missed: 1 });
    expect(get("SELECT unread_count FROM threads WHERE id='t_1'").unread_count).toBe(0);
    expect(get("SELECT unread_count FROM threads WHERE id='t_2'").unread_count).toBe(0);
    expect(get("SELECT flags_bitmap FROM messages WHERE id='m_unread'").flags_bitmap).toBe(1);

    const aliases = await call("/api/inbox/aliases?domain=d_1");
    expect((aliases.json.data as Array<Record<string, unknown>>)[0]!.unread_count).toBe(0);
  });

  it("sets and clears star/archive bits with one expression", async () => {
    await call("/api/inbox/threads/batch/flags", {
      ids: ["t_1"],
      star: true,
      archive: true,
    });
    expect(get("SELECT flags_bitmap FROM threads WHERE id='t_1'").flags_bitmap).toBe(6);

    await call("/api/inbox/threads/batch/flags", {
      ids: ["t_1"],
      star: false,
    });
    expect(get("SELECT flags_bitmap FROM threads WHERE id='t_1'").flags_bitmap).toBe(4);
  });

  it("never touches another owner's thread", async () => {
    const { json } = await call("/api/inbox/threads/batch/flags", {
      ids: ["t_other"],
      star: true,
    });
    expect(json).toMatchObject({ updated: 0, missed: 1 });
    expect(get("SELECT flags_bitmap FROM threads WHERE id='t_other'").flags_bitmap).toBe(0);
  });

  it("validates the id list", async () => {
    expect((await call("/api/inbox/threads/batch/flags", { ids: [] })).status).toBe(422);
    expect(
      (
        await call("/api/inbox/threads/batch/flags", {
          ids: Array.from({ length: 101 }, (_, i) => `t_${i}`),
        })
      ).status,
    ).toBe(422);
  });

  it("splits a full 100-id batch under the bind limit", async () => {
    const ids = [
      "t_1",
      "t_2",
      ...Array.from({ length: 98 }, (_, i) => `missing_${i}`),
    ];
    const { status, json } = await call("/api/inbox/threads/batch/flags", {
      ids,
      read: true,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ updated: 2, missed: 98 });
    expect(get("SELECT unread_count FROM threads WHERE id='t_1'").unread_count).toBe(0);
    expect(get("SELECT unread_count FROM threads WHERE id='t_2'").unread_count).toBe(0);
  });

  it("applies a single-thread flag", async () => {
    const { status } = await call("/api/inbox/threads/t_1/flags", { spam: true });
    expect(status).toBe(200);
    expect(get("SELECT flags_bitmap FROM threads WHERE id='t_1'").flags_bitmap).toBe(16);
  });
});
