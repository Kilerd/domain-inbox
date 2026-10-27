// Real SQLite (node:sqlite) with every migration applied, behind a minimal
// D1 facade. Shared by the route-level tests so the UNIQUE constraints,
// subqueries and bit operations run for real.

import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";

export function openDb(): DatabaseSyncType {
  // vite-node can't resolve the prefix-only `node:sqlite` builtin through a
  // static import, so fetch it from the runtime directly.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  return db;
}

export function d1(
  db: DatabaseSyncType,
  beforeRun?: (sql: string) => void,
): D1Database {
  return {
    prepare(sql: string) {
      let params: SQLInputValue[] = [];
      const stmt = {
        bind(...p: unknown[]) {
          params = p as SQLInputValue[];
          return stmt;
        },
        async first() {
          const row = db.prepare(sql).get(...params);
          return row ? { ...row } : null;
        },
        async all() {
          const results = db.prepare(sql).all(...params).map((r) => ({ ...r }));
          return { results, success: true, meta: {} };
        },
        async run() {
          beforeRun?.(sql);
          const r = db.prepare(sql).run(...params);
          return { results: [], success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}
