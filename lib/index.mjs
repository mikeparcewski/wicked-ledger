/**
 * wicked-ledger — public API barrel.
 *
 * The wicked evidence ledger: a dual-write (canonical JSON + better-sqlite3
 * index) DomainStore for projects / strategies / scenarios / runs / verdicts /
 * tasks, a fixed parameterized oracle-query library, an evidence-manifest
 * builder, additive versioned SQLite migrations, and fire-and-forget bus
 * emission.
 *
 * Extracted from the retired wicked-testing package's self-contained ledger
 * modules (Stage 1 of the evidence-ledger → infra carve). Phase 6c completed
 * the fold: the consumers (wicked-crew / wicked-garden's qe skills) now read
 * and write through this package, the on-disk root renamed to `.wicked-qe/`
 * (legacy `.wicked-testing/` roots still resolve — see resolveLedgerRoot),
 * and bus events stamp domain `qe`.
 *
 * Import the whole surface from the root:
 *   import { createDomainStore, buildOracleQuery, buildManifest } from "wicked-ledger";
 *
 * ...or a single module by subpath:
 *   import { createDomainStore } from "wicked-ledger/domain-store";
 *   import { buildOracleQuery } from "wicked-ledger/oracle-queries";
 */

// --- DomainStore (dual-write JSON + SQLite index) ---
export {
  DomainStore,
  createDomainStore,
  resolveLedgerRoot,
  LEDGER_DIRNAME,
  LEGACY_LEDGER_DIRNAME,
  SCHEMA_VERSION,
  __resetDomainStoreCacheForTests,
} from "./domain-store.mjs";

// --- Oracle: fixed parameterized query library (no LLM-generated SQL) ---
export {
  QUERIES,
  QUERY_NAMES,
  routeQuestion,
  buildOracleQuery,
  supportedPatterns,
} from "./oracle-queries.mjs";

// --- Evidence manifest builder + verdict enum ---
export {
  buildManifest,
  MANIFEST_VERSION,
  VERDICT_VALUES,
} from "./manifest.mjs";

// --- Versioned migration runner ---
export { applyMigrations, listMigrations } from "./migrate.mjs";

// --- Fire-and-forget wicked-bus emission ---
export {
  emitBusEvent,
  domainEventToBusEvent,
  __resetBusAvailabilityForTests,
} from "./bus-emit.mjs";

// --- WICKED_RUNTIME profile resolution (foundation team-profile seam) ---
export { resolveRuntimeProfile, assertRuntimeSupported } from "./runtime.mjs";

// Default export mirrors the most common entry point.
export { default } from "./domain-store.mjs";
