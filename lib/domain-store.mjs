/**
 * lib/domain-store.mjs — the wicked-ledger DomainStore
 *
 * Node.js port of wicked-garden's _domain_store.py.
 * Dual-write: JSON canonical + SQLite index (better-sqlite3).
 * Graceful degradation: if better-sqlite3 fails to load, JSON-only mode.
 *
 * Divergences from reference (see DATA-DOMAIN.md §3):
 *   - Language: Python → Node.js ESM
 *   - Storage: home-global → project-local (.wicked-qe/; legacy .wicked-testing/ roots keep working — see resolveLedgerRoot)
 *   - Integration routing: removed (local-only)
 *   - Event emission: routes CRUD ops to lib/bus-emit.mjs (best-effort fire-and-forget)
 *   - Synchronous-only API (fs.writeFileSync, better-sqlite3 sync)
 *   - schema_migrations table + strict version check
 *   - Per-query prepared-statement cache
 *
 * API surface (matches reference CRUD method names):
 *   store.create(source, payload) → Object
 *   store.list(source, params)    → Array<Object>
 *   store.get(source, id)         → Object | null
 *   store.update(source, id, diff)→ Object | null
 *   store.delete(source, id)      → boolean
 *   store.search(source, q, params) → Array<Object>
 *   store.schemaVersion()         → number
 *   store.rebuildIndex()          → void
 *   store.close()                 → void
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, fdatasyncSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { emitBusEvent, domainEventToBusEvent } from "./bus-emit.mjs";
import { applyMigrations } from "./migrate.mjs";
import { VERDICT_VALUES } from "./manifest.mjs";
import { assertRuntimeSupported } from "./runtime.mjs";

// Pre-write verdict guard set. Built once from the single source of truth
// (lib/manifest.mjs VERDICT_VALUES — the same list validateShape and the
// schema use). The verdicts.verdict CHECK constraint (migration 002) enforces
// this at the index, but create() writes canonical JSON FIRST; without this
// application-layer check a bogus verdict would land in JSON and then be
// rejected by the CHECK, leaving a JSON-vs-index split-brain (the row is
// invisible to every index-backed reader). Validating here lets create() fail
// loudly and atomically — nothing is written to either store.
const VERDICT_VALUES_SET = new Set(VERDICT_VALUES);

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// --- SQLite driver load (graceful degradation) ---
let Database = null;

try {
  const require = createRequire(import.meta.url);
  Database = require("better-sqlite3");
} catch (err) {
  const abiMismatch = /NODE_MODULE_VERSION|compiled against a different Node|ERR_DLOPEN_FAILED/i.test(String(err && err.message));
  if (abiMismatch) {
    process.stderr.write(
      `[wicked-ledger] better-sqlite3 failed to load (ABI mismatch) — domain store will be JSON-only.\n  Reason: ${err.message}\n  Run \`npm rebuild better-sqlite3\` to restore the SQLite index (oracle/insight queries require it).\n`
    );
  } else {
    process.stderr.write(
      `[wicked-ledger] better-sqlite3 failed to load — domain store will be JSON-only until you reinstall or run 'npm rebuild better-sqlite3'.\n  Reason: ${err.message}\n`
    );
  }
}

// --- Constants ---
// Bumped to 2 in migration 002 (verdict CHECK constraint + verdicts.equivalence_json).
// Bumped to 3 in migration 003 (verdicts.vault_payload_sha — wicked-vault absorption).
// This MUST track the highest migration version under lib/migrations/ — the
// forward-compat lockout in _initDb() refuses to open a DB whose recorded
// schema version exceeds this constant, so a stale value here would lock the
// store out of its own freshly-migrated database.
export const SCHEMA_VERSION = 3;
const TABLES = ["projects", "strategies", "scenarios", "runs", "verdicts", "tasks"];
const TABLES_SET = new Set(TABLES);
// Max age before a `runs` row stuck in 'running' is swept on init (1 hour).
const STALE_RUN_CUTOFF_MS = 60 * 60 * 1000;
// .tmp.* files older than this get cleaned on init (5 minutes — generous so
// a slow atomicWriteJson isn't reaped out from under itself).
const STALE_TMP_CUTOFF_MS = 5 * 60 * 1000;

// Read our own package version so bus events carry it (per INTEGRATION.md
// common-fields contract). Best-effort: if package.json cannot be read for
// any reason (packaged differently, stripped during publish), fall back to
// an empty string — events still fire, they just omit that field.
let _pkgVersion = "";
try {
  const pkgPath = join(__dirname, "..", "package.json");
  _pkgVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "";
} catch (_) { /* leave as "" */ }

// Column lists per table (used for INSERT/UPDATE prepared statements)
const TABLE_COLUMNS = {
  projects:   ["id", "name", "description", "created_at", "updated_at", "deleted", "deleted_at"],
  strategies: ["id", "project_id", "name", "body", "created_at", "updated_at", "deleted", "deleted_at"],
  scenarios:  ["id", "project_id", "strategy_id", "name", "format_version", "body", "source_path", "created_at", "updated_at", "deleted", "deleted_at"],
  runs:       ["id", "project_id", "scenario_id", "started_at", "finished_at", "status", "evidence_path", "created_at", "updated_at", "deleted", "deleted_at"],
  // vault_payload_sha: content-addressed payload SHA from wicked-vault record().
  // Populated when a verdict is created alongside vault evidence capture.
  // NULL for pre-absorption verdicts and verdicts created without vault evidence.
  //
  // KNOWN GAP — vault_payload_sha is NOT automatically populated by this store.
  // Callers must wire it explicitly:
  //   1. Call `wicked-vault record` (or import record() from the wicked-vault
  //      package: `wicked-vault/src/vault/vault.mjs`) to
  //      capture evidence and get back a `payload_sha256`.
  //   2. Pass `vault_payload_sha: payload_sha256` when calling
  //      store.create("verdicts", { ..., vault_payload_sha: payload_sha256 }).
  //
  // When vault_payload_sha is present, DomainStore emits wicked.test.evidence.captured
  // alongside wicked.test.verdict.created (see _emitEvent + domainEventToBusEvent).
  // When absent (most existing callers), only wicked.test.verdict.created fires.
  //
  // Automatic wiring into the acceptance pipeline is a follow-on task:
  // acceptance-test-executor should call vault.record() and pass the resulting
  // payload_sha256 into the verdict create call to close the loop automatically.
  verdicts:   ["id", "run_id", "verdict", "evidence_path", "reviewer", "reason", "equivalence_json", "vault_payload_sha", "created_at", "updated_at", "deleted", "deleted_at"],
  tasks:      ["id", "project_id", "title", "body", "status", "assignee_skill", "created_at", "updated_at", "deleted", "deleted_at"],
};

// --- Utility ---
function now() {
  return new Date().toISOString();
}

function atomicWriteJson(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + Date.now();
  const content = JSON.stringify(data, null, 2);
  writeFileSync(tmp, content, "utf8");
  // fsync the temp file
  try {
    const fd = openSync(tmp, "r");
    fdatasyncSync(fd);
    closeSync(fd);
  } catch (_) {
    // fdatasync may not be available on all platforms — continue
  }
  // POSIX rename atomically overwrites the destination; Windows rejects a
  // rename onto an existing file (EPERM/EEXIST/EACCES). Fall back to
  // unlink-then-rename on win32 so canonical JSON updates work cross-platform.
  try {
    renameSync(tmp, filePath);
  } catch (e) {
    if (process.platform === "win32" && (e.code === "EPERM" || e.code === "EEXIST" || e.code === "EACCES")) {
      try { unlinkSync(filePath); } catch (_) { /* may not exist yet */ }
      renameSync(tmp, filePath);
    } else {
      try { unlinkSync(tmp); } catch (_) { /* avoid leaking the temp file */ }
      throw e;
    }
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

// Wrap a raw filesystem write error with a code the caller can branch on.
// Propagated by create/update/delete so callers see "canonical store is
// unavailable" instead of a bare EACCES / ENOSPC escape.
function jsonWriteError(source, id, op, cause) {
  const err = new Error(
    `wicked-ledger: canonical JSON ${op} failed for ${source}/${id}: ${cause?.message ?? cause}`
  );
  err.code = "ERR_JSON_WRITE_FAILED";
  err.cause = cause;
  return err;
}

// --- DomainStore class ---
// Module-level singleton cache keyed by resolved root path. Multiple callers
// of createDomainStore() with the same root return the same instance instead
// of re-opening the SQLite handle and re-running migrations each time. Tests
// can reset via __resetDomainStoreCacheForTests().
const _instances = new Map();

export class DomainStore {
  constructor(root) {
    this._root = root;
    this._db = null;
    this._stmts = {};
    this._sqliteAvailable = false;
    this._driftCount = 0;

    mkdirSync(root, { recursive: true });
    this._sweepStaleTmpFiles();

    if (Database) {
      this._initDb();
    }
  }

  // Table-name allowlist guard. Every CRUD method that interpolates `source`
  // into a SQL string must call this first. Prevents a caller from smuggling
  // a crafted table name through user-supplied metadata. Pairs with the
  // existing column-name allowlist on list/_dbUpdate.
  _assertTable(source) {
    if (!TABLES_SET.has(source)) {
      const err = new Error(`wicked-ledger: invalid source '${source}' — must be one of: ${TABLES.join(", ")}`);
      err.code = "ERR_INVALID_SOURCE";
      throw err;
    }
  }

  // Reject an out-of-enum verdict at the application layer BEFORE the
  // dual-write. The verdicts.verdict CHECK constraint (migration 002) would
  // reject it at the SQLite index, but create() writes canonical JSON first —
  // so without this guard a bogus verdict produces a JSON-vs-index split-brain
  // (drift_count++ + stderr, JSON has the row, index doesn't, get() returns
  // null). Throwing here keeps both stores in agreement: nothing is written.
  // Only enforced when a verdict value is actually supplied (the column is NOT
  // NULL at the schema level, so a missing value is left to the DB insert; an
  // explicit out-of-enum string is the fail-loud case the CHECK promises).
  _assertVerdictValue(payload) {
    if (payload == null || payload.verdict === undefined || payload.verdict === null) return;
    if (!VERDICT_VALUES_SET.has(payload.verdict)) {
      const err = new Error(
        `wicked-ledger: invalid verdict value '${payload.verdict}' — must be one of: ${VERDICT_VALUES.join(", ")}`
      );
      err.code = "ERR_INVALID_VERDICT";
      throw err;
    }
  }

  _initDb() {
    // Index filename (Phase 6c rename): new stores use `wicked-qe.db`. A
    // store whose root already carries the legacy `wicked-testing.db` (and
    // no new-name db) keeps it — the index is derived, but reusing it avoids
    // an orphan file + a full rebuild on upgrade.
    const currentDb = join(this._root, "wicked-qe.db");
    const legacyDb = join(this._root, "wicked-testing.db");
    const dbPath = !existsSync(currentDb) && existsSync(legacyDb) ? legacyDb : currentDb;
    try {
      this._db = new Database(dbPath);
      this._db.pragma("journal_mode = WAL");
      this._db.pragma("foreign_keys = ON");

      // Apply pending migrations (see lib/migrate.mjs). Replaces the previous
      // monolithic schema.sql read. Fresh DBs get every migration applied in
      // order; existing v1 DBs see "1 already applied" and no-op.
      applyMigrations(this._db, join(__dirname, "migrations"));

      // Check schema version — refuse to write against a DB written by a
      // newer code version than this one (forward-compat lockout).
      const versionRow = this._db
        .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
        .get();

      if (versionRow && versionRow.version > SCHEMA_VERSION) {
        this._db.close();
        this._db = null;
        throw new Error(
          `ledger index db was written by a newer version (DB v${versionRow.version}, code v${SCHEMA_VERSION}). ` +
          `Upgrade wicked-ledger: npm install wicked-ledger@latest`
        );
      }

      this._sqliteAvailable = true;
      this._prepareStatements();

      // Reclaim any `running` runs that didn't finish cleanly last session
      // (executor crash, CLI kill mid-pipeline). Must run after statements
      // are prepared since we use update() internally.
      this._sweepStaleRunningRuns();
    } catch (err) {
      process.stderr.write(`[wicked-ledger] SQLite init failed: ${err.message}\n`);
      this._db = null;
    }
  }

  // Delete *.tmp.* files older than STALE_TMP_CUTOFF_MS. These are leftovers
  // from atomicWriteJson crashes (ENOSPC mid-write, process kill between
  // writeFileSync and renameSync). No cutoff = no reaping in-flight writes
  // from a concurrent process.
  _sweepStaleTmpFiles() {
    const cutoffMs = Date.now() - STALE_TMP_CUTOFF_MS;
    for (const source of TABLES) {
      const dir = join(this._root, source);
      if (!existsSync(dir)) continue;
      let names;
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!/\.tmp\.\d+$/.test(name)) continue;
        const path = join(dir, name);
        try {
          const st = statSync(path);
          if (st.mtimeMs < cutoffMs) unlinkSync(path);
        } catch { /* best effort */ }
      }
    }
  }

  // Reclaim `runs` rows stuck in 'running' state from a prior crash. Marks
  // each as 'errored' with a finished_at stamp. Goes through update() so the
  // `wicked.test.run.completed` event fires for consumers tracking lifecycle.
  _sweepStaleRunningRuns() {
    if (!this._sqliteAvailable) return;
    try {
      const cutoff = new Date(Date.now() - STALE_RUN_CUTOFF_MS).toISOString();
      const stale = this._db
        .prepare("SELECT id FROM runs WHERE status = 'running' AND started_at < ? AND deleted = 0")
        .all(cutoff);
      if (stale.length === 0) return;
      const finishedAt = now();
      for (const row of stale) {
        try {
          this.update("runs", row.id, {
            status: "errored",
            finished_at: finishedAt,
          });
        } catch (err) {
          process.stderr.write(`[wicked-ledger] stale-run reclaim failed for runs/${row.id}: ${err.message}\n`);
        }
      }
      process.stderr.write(`[wicked-ledger] reclaimed ${stale.length} stale running run(s) (started > ${STALE_RUN_CUTOFF_MS / 60000}m ago)\n`);
    } catch (err) {
      // Watchdog is best-effort; must not block init.
      process.stderr.write(`[wicked-ledger] stale-run sweep failed: ${err.message}\n`);
    }
  }

  _prepareStatements() {
    if (!this._db) return;
    // Prepare INSERT statements for each table
    for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
      const colList = cols.join(", ");
      const placeholders = cols.map((c) => "@" + c).join(", ");
      this._stmts[`insert_${table}`] = this._db.prepare(
        `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`
      );
    }

    // Prepare soft-delete statement for each table
    for (const table of TABLES) {
      this._stmts[`soft_delete_${table}`] = this._db.prepare(
        `UPDATE ${table} SET deleted = 1, deleted_at = @deleted_at, updated_at = @updated_at WHERE id = @id`
      );
    }
  }

  // --- JSON path helper ---
  _jsonPath(source, id) {
    return join(this._root, source, `${id}.json`);
  }

  // --- SQLite write helpers ---
  _dbInsert(table, record) {
    if (!this._sqliteAvailable) return;
    this._assertTable(table);
    try {
      const stmt = this._stmts[`insert_${table}`];
      if (!stmt) return;
      const params = {};
      const cols = TABLE_COLUMNS[table];
      for (const col of cols) {
        params[col] = record[col] ?? null;
      }
      // better-sqlite3 auto-commits single statements atomically; wrapping a
      // one-shot stmt.run() in db.transaction(...) adds BEGIN/COMMIT overhead
      // and an extra WAL fsync for no correctness gain. Direct call.
      stmt.run(params);
    } catch (err) {
      this._driftCount++;
      process.stderr.write(`[wicked-ledger] SQLite write failed for ${table}/${record.id}: ${err.message}\n`);
    }
  }

  _dbUpdate(table, id, fields) {
    if (!this._sqliteAvailable) return;
    this._assertTable(table);
    try {
      // Column-name allowlist: filter to schema columns only (prevents field-name injection)
      const allowed = TABLE_COLUMNS[table] || [];
      const safeFields = Object.fromEntries(
        Object.entries(fields).filter(([k]) => allowed.includes(k))
      );
      if (Object.keys(safeFields).length === 0) return;
      const setClauses = Object.keys(safeFields).map((k) => `${k} = @${k}`).join(", ");
      const stmt = this._db.prepare(`UPDATE ${table} SET ${setClauses} WHERE id = @_id`);
      // Single-statement — no transaction wrap needed. See _dbInsert comment.
      // Use safeFields (column-allowlisted) rather than the raw fields obj
      // so the params passed to the driver match the prepared SQL's named
      // placeholders exactly. Extra properties would be ignored, but this
      // is the consistent form.
      stmt.run({ ...safeFields, _id: id });
    } catch (err) {
      this._driftCount++;
      process.stderr.write(`[wicked-ledger] SQLite update failed for ${table}/${id}: ${err.message}\n`);
    }
  }

  // --- CRUD: create ---
  create(source, payload) {
    this._assertTable(source);
    // Validate the verdict value against the enum BEFORE any write so an
    // out-of-enum value fails loudly and atomically (no split-brain). See
    // _assertVerdictValue. No-op for non-verdict tables.
    if (source === "verdicts") this._assertVerdictValue(payload);
    const record = {
      id: payload.id || randomUUID(),
      ...payload,
      created_at: payload.created_at || now(),
      updated_at: payload.updated_at || now(),
      deleted: 0,
      deleted_at: null,
    };

    // 1. Atomic JSON write. Distinct from SQLite failure: a JSON write error
    // means the canonical store is down (permissions, ENOSPC, read-only FS),
    // not just the index. Surface a structured error code so the caller can
    // distinguish, instead of a raw EACCES escape.
    try {
      atomicWriteJson(this._jsonPath(source, record.id), record);
    } catch (err) {
      throw jsonWriteError(source, record.id, "create", err);
    }

    // 2. SQLite insert inside transaction (already wrapped; tolerates failure
    // by incrementing drift count and logging to stderr).
    this._dbInsert(source, record);

    // 3. Bus emission via routed hook (see bus-emit.mjs).
    this._emitEvent("create", source, record.id, record);

    return record;
  }

  // --- CRUD: get ---
  get(source, id) {
    this._assertTable(source);
    if (this._sqliteAvailable) {
      try {
        const stmt = this._db.prepare(`SELECT * FROM ${source} WHERE id = ? AND deleted = 0`);
        const row = stmt.get(id);
        if (!row) return null;
        return row;
      } catch (_) {
        // Fall through to JSON
      }
    }
    const data = readJson(this._jsonPath(source, id));
    if (!data || data.deleted) return null;
    return data;
  }

  // --- CRUD: list ---
  list(source, params = {}) {
    this._assertTable(source);
    // Column-name allowlist: reject any key not in the schema to prevent injection
    const allowed = TABLE_COLUMNS[source] || [];
    const safeParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => allowed.includes(k))
    );

    if (this._sqliteAvailable) {
      try {
        let query = `SELECT * FROM ${source} WHERE deleted = 0`;
        const bindings = [];
        for (const [key, val] of Object.entries(safeParams)) {
          if (key === "deleted") continue; // handled above
          query += ` AND ${key} = ?`;
          bindings.push(val);
        }
        query += " ORDER BY created_at DESC";
        return this._db.prepare(query).all(...bindings);
      } catch (_) {
        // Fall through to JSON
      }
    }

    // JSON-only fallback
    const dir = join(this._root, source);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    let results = files
      .map((f) => readJson(join(dir, f)))
      .filter((r) => r && !r.deleted);

    // Filter by safeParams (column allowlist already applied above)
    for (const [key, val] of Object.entries(safeParams)) {
      if (key === "deleted") continue;
      results = results.filter((r) => r[key] === val);
    }

    return results.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  }

  // --- CRUD: update ---
  update(source, id, diff) {
    this._assertTable(source);
    const jsonPath = this._jsonPath(source, id);
    const existing = readJson(jsonPath);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...diff,
      updated_at: now(),
    };

    // 1. Atomic JSON write
    try {
      atomicWriteJson(jsonPath, updated);
    } catch (err) {
      throw jsonWriteError(source, id, "update", err);
    }

    // 2. SQLite update
    const sqlFields = { ...diff, updated_at: updated.updated_at };
    this._dbUpdate(source, id, sqlFields);

    this._emitEvent("update", source, id, updated);
    return updated;
  }

  // --- CRUD: delete (soft) ---
  delete(source, id) {
    this._assertTable(source);
    const jsonPath = this._jsonPath(source, id);
    const existing = readJson(jsonPath);
    if (!existing) return false;

    const deletedAt = now();
    const updated = {
      ...existing,
      deleted: 1,
      deleted_at: deletedAt,
      updated_at: deletedAt,
    };

    // 1. Atomic JSON write
    try {
      atomicWriteJson(jsonPath, updated);
    } catch (err) {
      throw jsonWriteError(source, id, "delete", err);
    }

    // 2. SQLite soft-delete — single statement, direct run (no transaction
    // wrap; see _dbInsert for rationale).
    if (this._sqliteAvailable) {
      try {
        const stmt = this._stmts[`soft_delete_${source}`];
        if (stmt) {
          stmt.run({ id, deleted_at: deletedAt, updated_at: deletedAt });
        }
      } catch (err) {
        this._driftCount++;
        process.stderr.write(`[wicked-ledger] SQLite delete failed for ${source}/${id}: ${err.message}\n`);
      }
    }

    this._emitEvent("delete", source, id, null);
    return true;
  }

  // --- search ---
  search(source, q, params = {}) {
    this._assertTable(source);
    const results = this.list(source, params);
    if (!q) return results;
    const lower = q.toLowerCase();
    return results.filter((r) => {
      return ["title", "content", "summary", "description", "tags", "name", "body"].some(
        (field) => typeof r[field] === "string" && r[field].toLowerCase().includes(lower)
      );
    });
  }

  // --- Schema version ---
  schemaVersion() {
    if (this._sqliteAvailable) {
      try {
        const row = this._db
          .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
          .get();
        return row ? row.version : 0;
      } catch (_) {}
    }
    return SCHEMA_VERSION; // Default when JSON-only
  }

  // --- Rebuild index from JSON ---
  rebuildIndex() {
    if (!this._sqliteAvailable) {
      throw Object.assign(new Error("SQLite unavailable — cannot rebuild index"), {
        code: "ERR_SQLITE_UNAVAILABLE",
      });
    }

    // Disable FK enforcement during the drop/recreate — child tables
    // reference parents and dropping in any order would fail with
    // SQLITE_CONSTRAINT_FOREIGNKEY. Also needed for the bulk reload
    // below: the JSON scan loops over tables in TABLES order, which may
    // insert child rows before their parents are re-inserted (e.g.
    // scenarios before their project) and would otherwise fail FK.
    // Integrity is re-validated at the end via `PRAGMA foreign_key_check`.
    this._db.pragma("foreign_keys = OFF");
    try {
      const dropAndRecreate = this._db.transaction(() => {
        // Drop all tables
        for (const table of [...TABLES, "schema_migrations"]) {
          this._db.exec(`DROP TABLE IF EXISTS ${table}`);
        }
      });
      dropAndRecreate();

      // Re-apply schema via the migration runner (Wave 4 deleted the
      // monolithic schema.sql in favor of lib/migrations/).
      applyMigrations(this._db, join(__dirname, "migrations"));

      // Re-prepare statements after schema rebuild
      this._prepareStatements();

      // Scan JSON files and re-insert. Wrap the entire bulk load in ONE
      // explicit transaction — _dbInsert now runs each row at auto-commit
      // (Wave 10 removed the per-statement wrap), so rebuilds of N rows
      // would otherwise do N fsyncs. One outer transaction keeps the
      // rebuild O(1) in WAL syncs.
      const bulkReload = this._db.transaction(() => {
        for (const source of TABLES) {
          const dir = join(this._root, source);
          if (!existsSync(dir)) continue;
          const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
          for (const file of files) {
            const record = readJson(join(dir, file));
            if (record) {
              this._dbInsert(source, record);
            }
          }
        }
      });
      bulkReload();

      // Validate FK integrity after reload — loud failure if the rebuild
      // left orphan rows.
      const fkViolations = this._db.pragma("foreign_key_check", { simple: false });
      if (Array.isArray(fkViolations) && fkViolations.length > 0) {
        throw Object.assign(
          new Error(`rebuildIndex: ${fkViolations.length} FK violation(s) after reload`),
          { code: "ERR_REBUILD_FK_VIOLATION", violations: fkViolations }
        );
      }
    } finally {
      this._db.pragma("foreign_keys = ON");
    }
  }

  // --- Stats (row counts per table) ---
  stats() {
    if (!this._sqliteAvailable) {
      // JSON-only fallback: count files
      const counts = {};
      for (const source of TABLES) {
        const dir = join(this._root, source);
        if (existsSync(dir)) {
          counts[source] = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
        } else {
          counts[source] = 0;
        }
      }
      return { mode: "json-only", counts, drift_count: this._driftCount };
    }

    const counts = {};
    for (const source of TABLES) {
      try {
        const row = this._db.prepare(`SELECT COUNT(*) as n FROM ${source} WHERE deleted = 0`).get();
        counts[source] = row ? row.n : 0;
      } catch (_) {
        counts[source] = 0;
      }
    }
    return {
      mode: "sqlite+json",
      counts,
      schema_version: this.schemaVersion(),
      drift_count: this._driftCount,
    };
  }

  // --- Bus emission hook ---
  // Maps CRUD action + table to a public event per INTEGRATION.md § 4.
  // Emission is fire-and-forget: if wicked-bus is absent or the spawn fails,
  // nothing blocks the write. Never throws — bus-emit swallows its own errors.
  //
  // domainEventToBusEvent returns null, a single {type, payload}, or an array
  // of events (e.g. verdicts with vault_payload_sha fire two events: both
  // wicked.test.verdict.created and wicked.test.evidence.captured).
  _emitEvent(action, source, _id, record) {
    const ev = domainEventToBusEvent(action, source, record, _pkgVersion);
    if (!ev) return;
    if (Array.isArray(ev)) {
      for (const e of ev) emitBusEvent(e.type, e.payload);
    } else {
      emitBusEvent(ev.type, ev.payload);
    }
  }

  // --- Close DB ---
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
    // Remove from singleton cache so a subsequent createDomainStore() for
    // the same root gets a fresh instance (otherwise callers would get back
    // an instance with `_db = null` and every SQLite op would silently
    // degrade to JSON-only).
    const key = resolve(this._root);
    if (_instances.get(key) === this) _instances.delete(key);
  }

  // --- Mode ---
  get mode() {
    return this._sqliteAvailable ? "sqlite+json" : "json-only";
  }
}

/**
 * Default on-disk ledger dirname under a repo/cwd root (Phase 6c rename).
 * `.wicked-testing` is the LEGACY dirname the retired wicked-testing package
 * established; existing repos keep working via `resolveLedgerRoot`'s
 * dual-read fallback below.
 */
export const LEDGER_DIRNAME = ".wicked-qe";
export const LEGACY_LEDGER_DIRNAME = ".wicked-testing";

/**
 * Resolve the ledger root for a base directory (dual-read, Phase 6c):
 *   1. `<base>/.wicked-qe` when it exists — the current dirname wins;
 *   2. else `<base>/.wicked-testing` when it exists — a legacy store keeps
 *      its root (reads AND writes stay there; a ledger must never split
 *      across two roots);
 *   3. else `<base>/.wicked-qe` — new repos get the new dirname.
 */
export function resolveLedgerRoot(base = process.cwd()) {
  const current = join(base, LEDGER_DIRNAME);
  if (existsSync(current)) return current;
  const legacy = join(base, LEGACY_LEDGER_DIRNAME);
  if (existsSync(legacy)) return legacy;
  return current;
}

// --- Factory function (singleton per resolved root) ---
// Multiple callers in the same process get the same instance. Without this
// cache, every skill that imported the module and called createDomainStore()
// would open a fresh Database handle, re-run migrations, and re-prepare all
// statements — which worked thanks to SQLite's WAL mode but leaked fds and
// scattered the `_driftCount` counter across instances so `/stats` never
// reflected system-wide drift.
export function createDomainStore(opts = {}) {
  // WICKED_RUNTIME seam: fail loudly under a team profile BEFORE any store
  // I/O — there is no shared-store driver yet, and quietly opening the local
  // JSON+SQLite store would fork verdict state per engineer (lib/runtime.mjs).
  assertRuntimeSupported(opts.env);
  const root = opts.root || resolveLedgerRoot(process.cwd());
  const key = resolve(root);
  if (!_instances.has(key)) {
    _instances.set(key, new DomainStore(root));
  }
  return _instances.get(key);
}

/**
 * Test-only hook: drop every cached DomainStore without closing them. Tests
 * that spin up fresh stores under tmp dirs can call this between cases so
 * state from the previous case doesn't leak into the next. Do not call from
 * app code.
 */
export function __resetDomainStoreCacheForTests() {
  _instances.clear();
}

export default createDomainStore;
