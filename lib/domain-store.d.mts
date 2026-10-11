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

/**
 * update() diff: any subset of the record's DOMAIN fields. Store-stamped
 * fields are excluded — updated_at is always stamped by the store (a
 * supplied value is overridden), and soft-deletion goes through the
 * dedicated delete() API, not an update diff.
 */
export type UpdateInput<T extends TableName> = Partial<Omit<TableRecordMap[T], keyof BaseRecord>>;

/** list()/search() equality filters — non-schema keys are ignored (column allowlist). */
export type ListParams<T extends TableName> = Partial<TableRecordMap[T]>;

/**
 * Index coherence state (FND-LDG-01): "coherent" — the index agrees with
 * canonical JSON and serves reads; "drifted" — they diverged, reads come from
 * JSON until rebuildIndex()/reopen; "unavailable" — no native index;
 * "newer-version" — the index belongs to a newer ledger and writes are refused.
 */
export type IndexState = "coherent" | "drifted" | "unavailable" | "newer-version";

export type DomainStoreStats =
  | {
      mode: "json-only"; counts: Record<TableName, number>; drift_count: number;
      index_coherent: false; index_state: "unavailable" | "newer-version";
      /** false when a newer-version index refuses writes (ERR_INDEX_NEWER_VERSION). */
      writable: boolean; refusal?: string;
    }
  | {
      mode: "sqlite+json"; counts: Record<TableName, number>; schema_version: number; drift_count: number;
      index_coherent: boolean; index_state: "coherent" | "drifted";
      /** Why the index was declared incoherent (present when index_coherent is false). */
      drift_reason?: string;
      writable: true;
    };

/**
 * Dual-write domain store: canonical JSON files + a better-sqlite3 index,
 * with graceful degradation to JSON-only when the native driver is
 * unavailable. Synchronous API throughout.
 *
 * Prefer createDomainStore() — it returns a per-root singleton.
 *
 * Error codes thrown by CRUD methods:
 *  - ERR_INVALID_SOURCE      — table name outside the allowlist
 *  - ERR_INVALID_VERDICT     — verdicts.create/update whose (merged) record has an out-of-enum or missing verdict
 *  - ERR_INVALID_RECORD      — create/update whose (merged) record misses a required column or has a dangling foreign key
 *  - ERR_INDEX_NEWER_VERSION — any write while the index belongs to a newer wicked-ledger (reads still work)
 *  - ERR_REBUILD_INCOMPLETE  — rebuildIndex() could not index every canonical JSON record
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
 * @param opts.root Store root directory (default: `resolveLedgerRoot(process.cwd())` — a
 *   `WICKED_QE_LEDGER_DIR` pin, else
 *   `<cwd>/.wicked-qe`, falling back to a legacy `<cwd>/.wicked-testing` when
 *   only that exists).
 */
export function createDomainStore(opts?: {
  root?: string;
  /**
   * Environment override for the WICKED_RUNTIME profile check (default:
   * process.env). Throws ERR_WICKED_RUNTIME_TEAM_UNSUPPORTED under
   * WICKED_RUNTIME=team — no shared-store driver exists yet (lib/runtime.mjs).
   */
  env?: Record<string, string | undefined>;
}): DomainStore;

/** Current on-disk ledger dirname (".wicked-qe"). */
export const LEDGER_DIRNAME: string;

/** Legacy dirname from the retired wicked-testing package (".wicked-testing"). */
export const LEGACY_LEDGER_DIRNAME: string;

/** The env variable that pins the ledger root ("WICKED_QE_LEDGER_DIR"). */
export const LEDGER_DIR_ENV: string;

/**
 * Ledger root resolution: a non-blank `WICKED_QE_LEDGER_DIR` in `env`
 * (default `process.env`) pins the root (absolute as given, relative under
 * `base`); otherwise dual-read (Phase 6c): `<base>/.wicked-qe` when present,
 * else `<base>/.wicked-testing` when present, else `<base>/.wicked-qe`.
 */
export function resolveLedgerRoot(base?: string, env?: Record<string, string | undefined>): string;

/**
 * Test-only hook: drop every cached DomainStore without closing them.
 * Do not call from app code.
 */
export function __resetDomainStoreCacheForTests(): void;

export default createDomainStore;
