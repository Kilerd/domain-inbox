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

import type { Env } from "../env";
import { d1, openDb } from "../test/sqlite";
import {
  autoReplySuppressed,
  maybeAutoReply,
  vacationConfig,
} from "./vacation";

const NOW = Date.UTC(2026, 9, 27, 12);
let db: DatabaseSyncType;
let env: Env;
let send: ReturnType<typeof vi.fn>;

function baseRaw(extra = ""): string {
  return `From: Sender <sender@other.test>\r\nTo: support@example.test\r\nSubject: Hi\r\n${extra}\r\nbody\r\n`;
}

beforeEach(() => {
  db = openDb();
  db.exec(`
    INSERT INTO users (id,email,name,auth_provider,role,created_at)
      VALUES ('u_1','u@example.test','U','magic_link','owner',0);
    INSERT INTO vacation_responders
      (owner_id,enabled,subject,body_text,start_at,end_at,updated_at)
      VALUES ('u_1',1,'Out of office','I am away.',NULL,NULL,0);
  `);
  send = vi.fn(async () => {});
  env = {
    DB: d1(db),
    EMAIL: { send } as unknown as SendEmail,
  } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("autoReplySuppressed", () => {
  it("rejects automated mail, own domains and postmaster", () => {
    expect(autoReplySuppressed(baseRaw(), "sender@other.test", "support@example.test")).toBe(false);
    expect(
      autoReplySuppressed(baseRaw("Auto-Submitted: auto-replied\r\n"), "sender@other.test", "support@example.test"),
    ).toBe(true);
    expect(
      autoReplySuppressed(baseRaw("List-Id: <list.example>\r\n"), "sender@other.test", "support@example.test"),
    ).toBe(true);
    expect(
      autoReplySuppressed(baseRaw("Precedence: bulk\r\n"), "sender@other.test", "support@example.test"),
    ).toBe(true);
    expect(autoReplySuppressed(baseRaw(), "me@example.test", "support@example.test")).toBe(true);
    expect(autoReplySuppressed(baseRaw(), "postmaster@other.test", "support@example.test")).toBe(true);
  });
});

describe("maybeAutoReply", () => {
  it("sends once and then suppresses the same sender", async () => {
    const opts = {
      ownerId: "u_1",
      from: "sender@other.test",
      to: "support@example.test",
      subject: "Hi",
      rawEml: baseRaw(),
    };
    expect(await maybeAutoReply(env, opts, NOW)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await maybeAutoReply(env, opts, NOW + 1000)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const log = db
      .prepare(`SELECT sent_at FROM auto_reply_log WHERE owner_id='u_1'`)
      .get() as { sent_at: number };
    expect(log.sent_at).toBe(NOW);
  });

  it("does nothing when disabled or outside the window", async () => {
    db.prepare(`UPDATE vacation_responders SET enabled=0 WHERE owner_id='u_1'`).run();
    expect(
      await maybeAutoReply(
        env,
        { ownerId: "u_1", from: "a@other.test", to: "support@example.test", subject: null, rawEml: baseRaw() },
        NOW,
      ),
    ).toBe(false);

    db.prepare(
      `UPDATE vacation_responders SET enabled=1, start_at=?2, end_at=?3 WHERE owner_id='u_1'`,
    ).run("u_1", NOW + 1000, NOW + 2000);
    expect(
      await maybeAutoReply(
        env,
        { ownerId: "u_1", from: "a@other.test", to: "support@example.test", subject: null, rawEml: baseRaw() },
        NOW,
      ),
    ).toBe(false);
  });

  it("exposes the stored config", async () => {
    const config = await vacationConfig(env, "u_1");
    expect(config).toMatchObject({ enabled: true, subject: "Out of office" });
  });
});
