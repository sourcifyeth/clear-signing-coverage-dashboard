/**
 * @ccd/db — SQLite storage for the coverage dashboard.
 *
 *   const db = openDb();            // $DB_PATH or <repo>/out/coverage.sqlite
 *   insertCoverage(db, rows, commit)
 *   const runId = insertAggregateRun(db, {...})
 *   insertPracticalRun(db, {...})
 *   readReport(db, runId, { limit: 200 })
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export type Db = Database.Database;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

export function defaultDbPath(): string {
  return path.resolve(process.env.DB_PATH ?? path.join(REPO_ROOT, "out", "coverage.sqlite"));
}

/** Open (or create) the database, enable WAL, apply the schema. */
export function openDb(dbPath: string = defaultDbPath(), opts?: { readonly?: boolean }): Db {
  if (!opts?.readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly: opts?.readonly ?? false });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (!opts?.readonly) db.exec(SCHEMA_SQL);
  return db;
}

export * from "./write.js";
export * from "./read.js";
