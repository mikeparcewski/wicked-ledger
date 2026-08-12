/**
 * Type declarations for lib/index.mjs — the wicked-ledger public API barrel.
 *
 * Mirrors the runtime barrel exactly: every value re-exported by
 * lib/index.mjs is declared here, plus the supporting types. Keep in
 * lockstep — CI runs `npm run typecheck` against a consumer-shaped test
 * file importing every symbol, so drift fails loudly.
 */

// --- DomainStore (dual-write JSON + SQLite index) ---
export {
  DomainStore,
  createDomainStore,
  SCHEMA_VERSION,
  __resetDomainStoreCacheForTests,
} from "./domain-store.mjs";
export type {
  TableName,
  StoreMode,
  TaskStatus,
  BaseRecord,
  ProjectRecord,
  StrategyRecord,
  ScenarioRecord,
  RunRecord,
  VerdictRecord,
  TaskRecord,
  TableRecordMap,
  CreateInput,
  UpdateInput,
  ListParams,
  DomainStoreStats,
} from "./domain-store.mjs";

// --- WICKED_RUNTIME profile resolution (foundation team-profile seam) ---
export { resolveRuntimeProfile, assertRuntimeSupported } from "./runtime.mjs";
export type { RuntimeProfile, RuntimeProfileName } from "./runtime.mjs";

// --- Oracle: fixed parameterized query library (no LLM-generated SQL) ---
export {
  QUERIES,
  QUERY_NAMES,
  routeQuestion,
  buildOracleQuery,
  supportedPatterns,
} from "./oracle-queries.mjs";
export type {
  OracleQueryName,
  OracleQueryDef,
  OracleFilters,
  BuiltOracleQuery,
} from "./oracle-queries.mjs";

// --- Evidence manifest builder + verdict enum ---
export {
  buildManifest,
  MANIFEST_VERSION,
  VERDICT_VALUES,
} from "./manifest.mjs";
export type {
  Verdict,
  RunStatus,
  RunLifecycleStatus,
  EquivalenceMethod,
  VerdictEquivalence,
  ArtifactKind,
  ManifestArtifact,
  ManifestEnvironment,
  ManifestVerdict,
  ManifestAssertion,
  EvidenceManifest,
  BuildManifestRunRecord,
  BuildManifestScenarioRecord,
  BuildManifestVerdictRecord,
  BuildManifestOptions,
} from "./manifest.mjs";

// --- Versioned migration runner ---
export { applyMigrations, listMigrations } from "./migrate.mjs";
export type { SqliteDatabase, MigrationResult, MigrationInfo } from "./migrate.mjs";

// --- Fire-and-forget wicked-bus emission ---
export {
  emitBusEvent,
  domainEventToBusEvent,
  __resetBusAvailabilityForTests,
} from "./bus-emit.mjs";
export type { LedgerBusEventType, LedgerBusEvent, DomainAction } from "./bus-emit.mjs";

// Default export mirrors the most common entry point.
export { default } from "./domain-store.mjs";
