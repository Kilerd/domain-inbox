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
import { handleMembers } from "./members";

// The owner's user id is the workspace/data owner; the member's own id is only
// used for identity-sensitive checks.
const OWNER: AuthUser = {
  id: "u_owner",
  user_id: "u_owner",
  email: "owner@example.test",
  name: "Owner",
  role: "owner",
  is_new: false,
};
const MEMBER: AuthUser = {
  id: "u_owner",
  user_id: "u_member",
  email: "member@example.test",
  name: "Member",
  role: "member",
  is_new: false,
};

let db: DatabaseSyncType;
let env: Env;

function seed() {
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,workspace_owner_id,created_at) VALUES
      ('u_owner','owner@example.test','Owner','magic_link','owner','u_owner',0),
      ('u_member','member@example.test','Member','magic_link','member','u_owner',1);
    INSERT INTO domains (id,owner_id,domain,verification_status,catch_all_enabled,created_at) VALUES
      ('d_1','u_owner','shared.test','verified',1,0);
    INSERT INTO aliases (id,domain_id,local_part,full_address,type,target_user_id,created_at,message_count,last_message_at,hidden) VALUES
      ('a_1','d_1','hello','hello@shared.test','explicit','u_owner',0,1,0,0);
    INSERT INTO threads
      (id,owner_id,domain_id,subject_normalized,participants_json,last_message_at,first_message_at,message_count,unread_count,flags_bitmap)
    VALUES
      ('t_1','u_owner','d_1','shared subject','[]',0,0,1,1,0);
    INSERT INTO messages
      (id,thread_id,owner_id,domain_id,alias_id,rfc822_message_id,direction,subject,
       received_at,size_bytes,flags_bitmap,parse_status,created_at)
    VALUES
      ('m_1','t_1','u_owner','d_1','a_1','<m@x>','inbound','shared subject',0,10,0,'parsed',0);
  `);
}

beforeEach(() => {
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
  db.close();
});

function get(path: string) {
  return new Request(`https://worker.test${path}`);
}

async function inboxThreads(user: AuthUser) {
  const req = get("/api/inbox/threads?view=inbox&limit=10");
  const res = await handleInbox(new URL(req.url), req, env, user);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { threads: Array<{ id: string }> };
  return json.threads.map((t) => t.id);
}

describe("shared inbox", () => {
  it("shows the workspace owner's mail to a member", async () => {
    expect(await inboxThreads(MEMBER)).toEqual(["t_1"]);
    expect(await inboxThreads(OWNER)).toEqual(["t_1"]);
  });

  it("shows the workspace domains and aliases to a member", async () => {
    const req = get("/api/inbox/domains");
    const res = await handleInbox(new URL(req.url), req, env, MEMBER);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data.map((d) => d.id)).toEqual(["d_1"]);

    const aliasReq = get("/api/inbox/aliases?domain=d_1");
    const aliasRes = await handleInbox(new URL(aliasReq.url), aliasReq, env, MEMBER);
    const aliases = (await aliasRes.json()) as { data: Array<{ address: string }> };
    expect(aliases.data[0]!.address).toBe("hello@shared.test");
  });
});

describe("membership permissions", () => {
  it("lets the owner list members", async () => {
    const req = get("/api/v1/members");
    const res = await handleMembers(new URL(req.url), req, env, OWNER);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { members: Array<{ email: string; role: string }> };
    expect(json.members.map((m) => [m.email, m.role])).toEqual([
      ["owner@example.test", "owner"],
      ["member@example.test", "member"],
    ]);
  });

  it("rejects a member even though their data id is the owner's", async () => {
    const req = get("/api/v1/members");
    const res = await handleMembers(new URL(req.url), req, env, MEMBER);
    expect(res.status).toBe(403);
  });
});
