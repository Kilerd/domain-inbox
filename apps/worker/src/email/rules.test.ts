import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import { applyInboundRules, authFailureSpam } from "./rules";

let db: DatabaseSyncType;
let env: Env;

function seedMessage() {
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,created_at)
      VALUES ('u_1','u@example.test','U','magic_link','owner',0);
    INSERT INTO threads
      (id,owner_id,domain_id,subject_normalized,participants_json,last_message_at,
       first_message_at,message_count,unread_count,flags_bitmap)
      VALUES ('t_1','u_1',NULL,'new issue','[]',0,0,1,1,0);
    INSERT INTO messages
      (id,thread_id,owner_id,direction,from_addr,to_json,subject,has_attachments,
       flags_bitmap,parse_status,created_at)
      VALUES ('m_1','t_1','u_1','inbound','alerts@github.com','["support@example.test"]',
              'New issue',1,0,'parsed',0);
  `);
}

function addRule(id: string, match: object, actions: object, priority = 100) {
  db.prepare(
    `INSERT INTO email_rules
       (id,owner_id,name,enabled,priority,match_json,actions_json,created_at,updated_at)
     VALUES (?1,'u_1',?1,1,?2,?3,?4,0,0)`,
  ).run(id, priority, JSON.stringify(match), JSON.stringify(actions));
}

beforeEach(() => {
  db = openDb();
  seedMessage();
  env = { DB: d1(db) } as unknown as Env;
});

afterEach(() => db.close());

describe("authFailureSpam", () => {
  it("only quarantines when SPF, DKIM and DMARC all fail", () => {
    expect(
      authFailureSpam(
        "Authentication-Results: mx; spf=fail; dkim=fail; dmarc=fail\r\n",
      ),
    ).toBe(true);
    expect(
      authFailureSpam(
        "Authentication-Results: mx; spf=pass; dkim=fail; dmarc=fail\r\n",
      ),
    ).toBe(false);
    expect(authFailureSpam("Subject: no headers\r\n")).toBe(false);
  });
});

describe("applyInboundRules", () => {
  it("ORs the actions of every matching rule", async () => {
    addRule("r1", { from: "@github.com" }, { star: true }, 10);
    addRule("r2", { subject: "issue" }, { archive: true, read: true }, 20);
    addRule("r3", { to: "support@" }, { star: true }, 30);

    const spam = await applyInboundRules(env, "u_1", "m_1", false);
    expect(spam).toBe(false);

    const thread = db
      .prepare(`SELECT flags_bitmap, unread_count FROM threads WHERE id='t_1'`)
      .get() as { flags_bitmap: number; unread_count: number };
    expect(thread.flags_bitmap).toBe(2 | 4);
    expect(thread.unread_count).toBe(0);

    const msg = db
      .prepare(`SELECT flags_bitmap FROM messages WHERE id='m_1'`)
      .get() as { flags_bitmap: number };
    expect(msg.flags_bitmap & 1).toBe(1);
  });

  it("ignores conditions that do not match", async () => {
    addRule("r1", { from: "@gitlab.com" }, { spam: true });
    const spam = await applyInboundRules(env, "u_1", "m_1", false);
    expect(spam).toBe(false);
    const thread = db
      .prepare(`SELECT flags_bitmap FROM threads WHERE id='t_1'`)
      .get() as { flags_bitmap: number };
    expect(thread.flags_bitmap).toBe(0);
  });

  it("carries the automatic auth-result quarantine", async () => {
    const spam = await applyInboundRules(env, "u_1", "m_1", true);
    expect(spam).toBe(true);
    const thread = db
      .prepare(`SELECT flags_bitmap FROM threads WHERE id='t_1'`)
      .get() as { flags_bitmap: number };
    expect(thread.flags_bitmap & 16).toBe(16);
  });
});
