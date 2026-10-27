import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import { backfillSearchIndex, indexMessageForSearch } from "./search_index";

const RAW = [
  "From: Alice <alice@example.test>",
  "To: hello@example.test",
  "Subject: Quarterly needle",
  "Content-Type: text/plain",
  "",
  "the quick brown fox jumps",
].join("\r\n");

let db: DatabaseSyncType;
let env: Env;

beforeEach(() => {
  db = openDb();
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,created_at)
      VALUES ('u_1','u@example.test','U','magic_link','owner',0);
    INSERT INTO threads
      (id,owner_id,domain_id,subject_normalized,participants_json,last_message_at,
       first_message_at,message_count,unread_count,flags_bitmap)
      VALUES ('t_1','u_1',NULL,'quarterly needle','[]',0,0,1,1,0);
    INSERT INTO messages
      (id,thread_id,owner_id,direction,from_addr,to_json,subject,r2_key,
       flags_bitmap,parse_status,created_at)
      VALUES ('m_1','t_1','u_1','inbound','alice@example.test','["hello@example.test"]',
              'Quarterly needle','raw/x.eml',0,'parsed',0);
  `);
  env = {
    DB: d1(db),
    R2: {
      get: vi.fn(async () => ({
        arrayBuffer: async () => new TextEncoder().encode(RAW).buffer,
      })),
    } as unknown as R2Bucket,
  } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("search index", () => {
  it("indexes the parsed body and is idempotent", async () => {
    await indexMessageForSearch(env, "m_1");
    const row = db
      .prepare(`SELECT subject, body, from_addr, to_text FROM message_fts WHERE message_id='m_1'`)
      .get() as { subject: string; body: string; from_addr: string; to_text: string };
    expect(row.subject).toBe("Quarterly needle");
    expect(row.body).toContain("quick brown fox");
    expect(row.from_addr).toBe("alice@example.test");
    expect(row.to_text).toBe("hello@example.test");

    await indexMessageForSearch(env, "m_1");
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM message_fts WHERE message_id='m_1'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("backfills unindexed parsed messages once", async () => {
    expect(await backfillSearchIndex(env, 10)).toBe(1);
    expect(await backfillSearchIndex(env, 10)).toBe(0);
  });
});
