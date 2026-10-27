import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import type { ApiKeyAuth } from "./apikey_auth";
import { handleReceiving } from "./receiving";

const RAW1 = [
  "From: Alice <alice@example.com>",
  "To: hello@example.test",
  "Subject: Invoice 1",
  "Message-ID: <in1@example.com>",
  "X-Test-Header: yes",
  'Content-Type: multipart/alternative; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "invoice body",
  "--b",
  "Content-Type: text/html",
  "",
  "<p>invoice body</p>",
  "--b--",
  "",
].join("\r\n");

const RAW2 = [
  "From: Bob <bob@example.com>",
  "To: sales@other.test",
  "Subject: Hello",
  "Message-ID: <in2@example.com>",
  "Content-Type: text/plain",
  "",
  "hello there",
].join("\r\n");

const KEY: ApiKeyAuth = {
  user_id: "u_1",
  key_id: "k_1",
  scopes: ["emails.read"],
  domain_scope: null,
};
const SCOPED: ApiKeyAuth = { ...KEY, key_id: "k_2", domain_scope: ["d_2"] };
const NO_READ: ApiKeyAuth = { ...KEY, key_id: "k_3", scopes: ["emails.send"] };

let db: DatabaseSyncType;
let env: Env;

function seed() {
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,created_at)
      VALUES ('u_1','u@example.test','U','magic_link','owner',0);
    INSERT INTO domains (id,owner_id,domain,verification_status,created_at)
      VALUES ('d_1','u_1','example.test','verified',0),
             ('d_2','u_1','other.test','verified',0);
    INSERT INTO threads (id,owner_id,domain_id,subject_normalized,participants_json,
                         last_message_at,first_message_at,message_count,unread_count,flags_bitmap)
      VALUES ('t_1','u_1','d_1','invoice 1','[]',1000,1000,1,0,0),
             ('t_2','u_1','d_2','hello','[]',2000,2000,1,0,0);
    INSERT INTO messages
      (id,thread_id,owner_id,domain_id,direction,from_addr,from_name,to_json,
       subject,snippet,received_at,rfc822_message_id,in_reply_to,references_json,
       r2_key,size_bytes,has_attachments,attachment_count,flags_bitmap,parse_status,created_at)
      VALUES
      ('m_in1','t_1','u_1','d_1','inbound','alice@example.com','Alice',
       '["hello@example.test"]','Invoice 1','invoice body',1000,'in1@example.com',NULL,NULL,
       'raw/m_in1.eml',100,1,1,1,'parsed',1000),
      ('m_in2','t_2','u_1','d_2','inbound','bob@example.com','Bob',
       '["sales@other.test"]','Hello','hello there',2000,'in2@example.com',NULL,NULL,
       'raw/m_in2.eml',50,0,0,1,'parsed',2000),
      ('m_out','t_1','u_1','d_1','outbound','hello@example.test',NULL,
       '["alice@example.com"]','Sent','sent body',3000,'out@example.com',NULL,NULL,
       'raw/m_out.eml',10,0,0,1,'parsed',3000),
      ('m_dup','t_1','u_1','d_1','inbound','alice@example.com',NULL,
       '["hello@example.test"]','Duplicate','dup',4000,'dup@example.com',NULL,NULL,
       'raw/m_dup.eml',10,0,0,1,'duplicate',4000);
    INSERT INTO attachments
      (id,message_id,filename,content_type,size_bytes,content_id,is_inline,r2_key,sha256)
      VALUES ('a_1','m_in1','invoice.pdf','application/pdf',7,NULL,0,'att/a_1.bin','sha');
  `);
}

beforeEach(() => {
  db = openDb();
  seed();
  const objects: Record<string, string> = {
    "raw/m_in1.eml": RAW1,
    "raw/m_in2.eml": RAW2,
    "att/a_1.bin": "PDFDATA",
  };
  env = {
    DB: d1(db),
    R2: {
      get: vi.fn(async (key: string) => {
        const value = objects[key];
        if (!value) return null;
        return {
          body: value,
          arrayBuffer: async () => new TextEncoder().encode(value).buffer,
        };
      }),
    } as unknown as R2Bucket,
  } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

async function call(path: string, key: ApiKeyAuth = KEY) {
  const req = new Request(`https://worker.test${path}`);
  return handleReceiving(new URL(req.url), req, env, key);
}

async function json(path: string, key: ApiKeyAuth = KEY) {
  const res = await call(path, key);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("receiving API", () => {
  it("lists inbound parsed mail only, newest first", async () => {
    const { status, body } = await json("/api/v1/emails/receiving");
    expect(status).toBe(200);
    expect((body.data as Array<Record<string, unknown>>).map((m) => m.id)).toEqual([
      "m_in2",
      "m_in1",
    ]);
    expect(body.data as unknown[]).toHaveLength(2);
  });

  it("supports filters and cursor pagination", async () => {
    expect(
      ((await json("/api/v1/emails/receiving?subject=invoice")).body.data as Array<{ id: string }>).map(
        (m) => m.id,
      ),
    ).toEqual(["m_in1"]);
    expect(
      ((await json("/api/v1/emails/receiving?from=alice")).body.data as Array<{ id: string }>).map(
        (m) => m.id,
      ),
    ).toEqual(["m_in1"]);

    const first = await json("/api/v1/emails/receiving?limit=1");
    expect((first.body.data as Array<{ id: string }>)[0]!.id).toBe("m_in2");
    const cursor = first.body.next_cursor as string;
    const second = await json(
      `/api/v1/emails/receiving?limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect((second.body.data as Array<{ id: string }>)[0]!.id).toBe("m_in1");
  });

  it("returns parsed body, headers and attachments", async () => {
    const { status, body } = await json("/api/v1/emails/receiving/m_in1");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: "m_in1",
      from: "alice@example.com",
      subject: "Invoice 1",
      text: "invoice body\n",
      raw_url: "/api/v1/emails/receiving/m_in1/raw",
    });
    expect(body.html).toContain("<p>invoice body</p>");
    expect((body.headers as Record<string, string>)["x-test-header"]).toBe("yes");
    expect((body.attachments as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "a_1",
      filename: "invoice.pdf",
      download_url: "/api/v1/emails/receiving/m_in1/attachments/a_1",
    });
  });

  it("serves the raw MIME and attachment bytes", async () => {
    const raw = await call("/api/v1/emails/receiving/m_in1/raw");
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("message/rfc822");
    expect(await raw.text()).toContain("Message-ID: <in1@example.com>");

    const att = await call("/api/v1/emails/receiving/m_in1/attachments/a_1");
    expect(att.status).toBe(200);
    expect(await att.text()).toBe("PDFDATA");
  });

  it("enforces domain scope", async () => {
    const list = await json("/api/v1/emails/receiving", SCOPED);
    expect((list.body.data as Array<{ id: string }>).map((m) => m.id)).toEqual(["m_in2"]);
    expect((await call("/api/v1/emails/receiving/m_in1", SCOPED)).status).toBe(404);
    expect((await call("/api/v1/emails/receiving/m_in1/raw", SCOPED)).status).toBe(404);
    expect(
      (await call("/api/v1/emails/receiving/m_in1/attachments/a_1", SCOPED)).status,
    ).toBe(404);
  });

  it("requires emails.read and hides outbound/duplicate ids", async () => {
    expect((await call("/api/v1/emails/receiving", NO_READ)).status).toBe(403);
    expect((await call("/api/v1/emails/receiving/m_out")).status).toBe(404);
    expect((await call("/api/v1/emails/receiving/m_dup")).status).toBe(404);
  });
});
