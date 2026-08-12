/**
 * Type declarations for lib/migrate.mjs — the versioned SQL migration runner.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/migrate.mjs — CI runs `npm run typecheck` so drift fails loudly.
 */

/**
 * Minimal structural view of a better-sqlite3 `Database` — the subset the
 * migration runner actually uses. Declared structurally so consumers are not
 * forced to install `@types/better-sqlite3`; a real better-sqlite3 Database
 * instance satisfies this interface.
 */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: any[]): unknown;
    get(...params: any[]): any;
    all(...params: any[]): any[];
  };
  transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
}

export interface MigrationResult {
  /** Migration filename, e.g. "002_verdict_check_and_equivalence.sql". */
  file: string;
  version: number;
  /**
   * "applied" when the DDL ran in this call; "already_applied" when the
   * version was recorded in schema_migrations beforehand. ("skipped" is
   * reserved by the documented contract but not currently emitted.)
   */
  status: "applied" | "already_applied" | "skipped";
}

export interface MigrationInfo {
  file: string;
  version: number;
  /** Filename description segment with underscores expanded to spaces. */
  description: string;
}

/**
 * Apply any pending migrations (migrations/NNN_description.sql, numeric
 * order, one transaction each) to an open better-sqlite3 database.
 * Self-bootstraps the schema_migrations bookkeeping table.
 *
 * @throws when migrationsDir does not exist, or a migration's DDL fails
 *         (the failing migration's transaction is rolled back).
 */
export function applyMigrations(db: SqliteDatabase, migrationsDir: string): MigrationResult[];

/**
 * Discover migrations without applying them (dry-runs / diagnostics).
 * Returns [] when migrationsDir does not exist.
 */
export function listMigrations(migrationsDir: string): MigrationInfo[];
