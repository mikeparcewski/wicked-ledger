/**
 * wicked-ledger — public API barrel.
 *
 * The wicked evidence ledger: a dual-write (canonical JSON + better-sqlite3
 * index) DomainStore for projects / strategies / scenarios / runs / verdicts /
 * tasks, a fixed parameterized oracle-query library, an evidence-manifest
 * builder, additive versioned SQLite migrations, and fire-and-forget bus
 * emission.
 *
 * Extracted verbatim from wicked-testing's self-contained ledger modules
 * (Stage 1 of the evidence-ledger → infra carve). The module internals are
 * intentionally unchanged from their wicked-testing origin — rewiring the
 * consumers (wicked-testing / crew / garden) onto this package is a later,
 * separate stage.
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

// Default export mirrors the most common entry point.
export { default } from "./domain-store.mjs";
