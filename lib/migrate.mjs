/**
 * lib/migrate.mjs — versioned SQL migration runner.
 *
 * Replaces the previous "read one schema.sql and hope it's idempotent"
 * pattern. Migrations live under `lib/migrations/NNN_description.sql` and
 * are applied in numeric order. Each migration is applied inside its own
 * transaction; already-applied versions are skipped.
 *
 * Bootstrap: the runner self-creates `schema_migrations` on first run, so
 * a fresh database comes up cleanly without any prior state.
 *
 * Backward compatibility: existing v1 databases have `schema_migrations`
 * already populated (row: `version=1, description='v1 initial 7-table schema'`),
 * so the runner sees version 1 is applied and skips `001_initial.sql`. No
 * re-execution, no double-applied indexes.
 *
 * Convention for new migrations:
 *   - Filename: `002_short_description.sql` (must match `/^\d+_.+\.sql$/`)
 *   - Contents: pure DDL. Do NOT write into `schema_migrations` from the
 *     SQL file — the runner records the row after `exec()` succeeds.
 *
 * The legacy `001_initial.sql` contains an `INSERT OR IGNORE` into
 * `schema_migrations` for backward compatibility with databases that were
 * created by the pre-runner code path. That's safe; the runner's own INSERT
 * below is also OR IGNORE, so one of them wins and either way version 1 is
 * marked applied exactly once.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FILENAME_RE = /^(\d+)_(.+)\.sql$/;

/**
 * Apply any pending migrations to an open better-sqlite3 Database.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} migrationsDir  Absolute path to the migrations directory.
 * @returns {Array<{file: string, version: number, status: "applied"|"skipped"|"already_applied"}>}
 *          Per-file outcome, in filename order, for logging / tests.
 */
export function applyMigrations(db, migrationsDir) {
  if (!existsSync(migrationsDir)) {
    throw new Error(`wicked-testing migrations dir not found: ${migrationsDir}`);
  }

  // Bootstrap the bookkeeping table so the runner can track itself. Safe to
  // run against an already-bootstrapped database — CREATE TABLE IF NOT EXISTS
  // is a no-op there.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL,
      description TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map(r => r.version)
  );

  const files = readdirSync(migrationsDir)
    .filter(f => FILENAME_RE.test(f))
    .sort(); // numeric prefix means lexicographic sort == version order

  const recordStmt = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)"
  );

  const results = [];
  for (const f of files) {
    const m = FILENAME_RE.exec(f);
    const version = Number(m[1]);
    const description = m[2].replace(/_/g, " ");
    if (applied.has(version)) {
      results.push({ file: f, version, status: "already_applied" });
      continue;
    }
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    const appliedAt = new Date().toISOString();

    // Wrap in a transaction so a mid-migration error leaves the DB untouched.
    // better-sqlite3 serializes DDL + INSERT inside the txn on a single
    // connection, so this is race-free.
    const run = db.transaction(() => {
      db.exec(sql);
      recordStmt.run(version, appliedAt, description);
    });
    run();
    results.push({ file: f, version, status: "applied" });
  }
  return results;
}

/**
 * Discover migrations without applying them. Useful for dry-runs and
 * diagnostics (`/wicked-testing:doctor`).
 *
 * @returns {Array<{file: string, version: number, description: string}>}
 */
export function listMigrations(migrationsDir) {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter(f => FILENAME_RE.test(f))
    .sort()
    .map(f => {
      const m = FILENAME_RE.exec(f);
      return { file: f, version: Number(m[1]), description: m[2].replace(/_/g, " ") };
    });
}
