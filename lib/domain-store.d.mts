/**
 * Type declarations for lib/domain-store.mjs — the dual-write
 * (canonical JSON + better-sqlite3 index) DomainStore.
 *
 * Hand-authored against the runtime module and the schema defined by
 * lib/migrations/ (see docs/SCHEMA-CONTRACT.md). Keep in lockstep with
 * lib/domain-store.mjs — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { Verdict, RunLifecycleStatus } from "./manifest.mjs";

/**
 * Highest migration version under lib/migrations/ — the schema version this
 * code writes at, and the forward-compat lockout ceiling (see
 * docs/SCHEMA-CONTRACT.md). Currently 3.
 */
export const SCHEMA_VERSION: number;

/** The six domain tables (plus schema_migrations bookkeeping, not CRUD-addressable). */
export type TableName = "projects" | "strategies" | "scenarios" | "runs" | "verdicts" | "tasks";

/** Storage mode: full dual-write, or JSON-only when better-sqlite3 failed to load. */
export type StoreMode = "sqlite+json" | "json-only";

/** Documented task-status taxonomy (see the tasks_by_status oracle query). */
export type TaskStatus = "open" | "in_progress" | "done" | "blocked";

/**
 * Fields stamped onto every record by the store.
 *
 * Nullability note: rows read back from the SQLite index carry every schema
 * column (missing values as `null`); rows read from canonical JSON carry only
 * the fields that were written (missing values as `undefined`). Optional
 * fields are therefore typed `field?: T | null`.
 */
export interface BaseRecord {
  /** UUID (server-minted unless supplied at create). */
  id: string;
  /** ISO-8601 creation timestamp. */
  created_at: string;
  /** ISO-8601 last-update timestamp. */
  updated_at: string;
  /** Soft-delete flag: 0 = live, 1 = deleted. Reads only return live rows. */
  deleted: 0 | 1;
  deleted_at: string | null;
}

export interface ProjectRecord extends BaseRecord {
  name: string;
  description?: string | null;
}

export interface StrategyRecord extends BaseRecord {
  project_id: string;
  name: string;
  body?: string | null;
}

export interface ScenarioRecord extends BaseRecord {
  project_id: string;
  strategy_id?: string | null;
  name: string;
  format_version: string;
  body?: string | null;
  source_path?: string | null;
}

export interface RunRecord extends BaseRecord {
  project_id: string;
  scenario_id: string;
  /** ISO-8601. Runs stuck in "running" past the stale cutoff are swept to "errored" on init. */
  started_at: string;
  finished_at?: string | null;
  status: RunLifecycleStatus;
  evidence_path?: string | null;
}

export interface VerdictRecord extends BaseRecord {
  run_id: string;
  /** Enforced against the verdict enum pre-write (ERR_INVALID_VERDICT) and by a CHECK constraint. */
  verdict: Verdict;
  evidence_path?: string | null;
  reviewer: string;
  reason?: string | null;
  /** Optional baseline-match facet as a JSON string (schema v2+). */
  equivalence_json?: string | null;
  /**
   * Content-addressed payload SHA from wicked-vault record() (schema v3+).
   * NOT auto-populated — callers wire it explicitly; when present,
   * wicked.test.evidence.captured fires alongside wicked.test.verdict.created.
   */
  vault_payload_sha?: string | null;
}

export interface TaskRecord extends BaseRecord {
  project_id: string;
  title: string;
  body?: string | null;
  status: TaskStatus;
  assignee_skill?: string | null;
}

/** Table name → record shape. */
export interface TableRecordMap {
  projects: ProjectRecord;
  strategies: StrategyRecord;
  scenarios: ScenarioRecord;
  runs: RunRecord;
  verdicts: VerdictRecord;
  tasks: TaskRecord;
}

/**
 * create() payload: the table's domain fields; id / created_at / updated_at
 * may be supplied, otherwise the store mints them. `deleted` / `deleted_at`
 * are always stamped by the store.
 */
export type CreateInput<T extends TableName> =
  Omit<TableRecordMap[T], keyof BaseRecord> &
  Partial<Pick<BaseRecord, "id" | "created_at" | "updated_at">>;

/** update() diff: any subset of the record's fields (updated_at is stamped by the store). */
export type UpdateInput<T extends TableName> = Partial<Omit<TableRecordMap[T], "id" | "created_at">>;

/** list()/search() equality filters — non-schema keys are ignored (column allowlist). */
export type ListParams<T extends TableName> = Partial<TableRecordMap[T]>;

export type DomainStoreStats =
  | { mode: "json-only"; counts: Record<TableName, number>; drift_count: number }
  | { mode: "sqlite+json"; counts: Record<TableName, number>; schema_version: number; drift_count: number };

/**
 * Dual-write domain store: canonical JSON files + a better-sqlite3 index,
 * with graceful degradation to JSON-only when the native driver is
 * unavailable. Synchronous API throughout.
 *
 * Prefer createDomainStore() — it returns a per-root singleton.
 *
 * Error codes thrown by CRUD methods:
 *  - ERR_INVALID_SOURCE      — table name outside the allowlist
 *  - ERR_INVALID_VERDICT     — verdicts.create with an out-of-enum verdict
 *  - ERR_JSON_WRITE_FAILED   — canonical JSON store unavailable (EACCES/ENOSPC/...)
 *  - ERR_SQLITE_UNAVAILABLE  — rebuildIndex() without a SQLite handle
 *  - ERR_REBUILD_FK_VIOLATION — rebuildIndex() left orphan rows
 */
export class DomainStore {
  constructor(root: string);

  /** Create a record (atomic JSON write, then SQLite insert, then bus emission). */
  create<T extends TableName>(source: T, payload: CreateInput<T>): TableRecordMap[T];

  /** Get one live record by id, or null. */
  get<T extends TableName>(source: T, id: string): TableRecordMap[T] | null;

  /** List live records, filtered by column equality, newest first. */
  list<T extends TableName>(source: T, params?: ListParams<T>): Array<TableRecordMap[T]>;

  /** Shallow-merge a diff into a record. Returns the updated record, or null when absent. */
  update<T extends TableName>(source: T, id: string, diff: UpdateInput<T>): TableRecordMap[T] | null;

  /** Soft-delete. Returns false when the record does not exist. */
  delete(source: TableName, id: string): boolean;

  /** list() plus a case-insensitive substring match over common text fields. */
  search<T extends TableName>(source: T, q?: string | null, params?: ListParams<T>): Array<TableRecordMap[T]>;

  /** Effective schema version: MAX(version) from schema_migrations (SCHEMA_VERSION when JSON-only). */
  schemaVersion(): number;

  /** Drop and rebuild the SQLite index from canonical JSON. Throws when SQLite is unavailable. */
  rebuildIndex(): void;

  /** Row counts per table plus mode / drift diagnostics. */
  stats(): DomainStoreStats;

  /** Close the SQLite handle and evict this instance from the singleton cache. */
  close(): void;

  /** Current storage mode. */
  get mode(): StoreMode;
}

/**
 * Factory: returns the per-resolved-root singleton DomainStore.
 *
 * @param opts.root Store root directory (default: `<cwd>/.wicked-testing`).
 */
export function createDomainStore(opts?: { root?: string }): DomainStore;

/**
 * Test-only hook: drop every cached DomainStore without closing them.
 * Do not call from app code.
 */
export function __resetDomainStoreCacheForTests(): void;

export default createDomainStore;
