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
import { isAllowed } from "./magic_link";

let db: DatabaseSyncType;
let env: Env;

function makeEnv(ownerEmail?: string): Env {
  return { DB: d1(db), OWNER_EMAIL: ownerEmail } as unknown as Env;
}

function owner(email = "owner@example.test") {
  db.prepare(
    `INSERT INTO users (id,email,name,auth_provider,role,created_at)
     VALUES ('u_owner', ?1, 'Owner', 'magic_link', 'owner', 0)`,
  ).run(email);
}

function allow(email: string) {
  db.prepare(
    `INSERT INTO auth_allowlist (email, role, created_at) VALUES (?1, 'member', 0)`,
  ).run(email);
}

beforeEach(() => {
  db = openDb();
  env = makeEnv();
});

afterEach(() => {
  db.close();
});

describe("first-boot allow rule", () => {
  it("rejects everyone when no OWNER_EMAIL and no allowlist exist", async () => {
    expect(await isAllowed(env, "anyone@example.test")).toBe(false);
  });

  it("only lets the configured OWNER_EMAIL bootstrap the owner", async () => {
    env = makeEnv("Owner@Example.Test");
    expect(await isAllowed(env, "owner@example.test")).toBe(true);
    expect(await isAllowed(env, "someone-else@example.test")).toBe(false);
  });

  it("still lets an explicitly allowlisted address in", async () => {
    allow("vip@example.test");
    expect(await isAllowed(env, "VIP@example.test")).toBe(true);
  });

  it("does not re-open bootstrap once an owner exists", async () => {
    owner();
    env = makeEnv("owner@example.test");
    expect(await isAllowed(env, "owner@example.test")).toBe(false);
    // The bootstrap path seeds the allowlist; that is how the owner returns.
    allow("owner@example.test");
    expect(await isAllowed(env, "owner@example.test")).toBe(true);
  });
});
