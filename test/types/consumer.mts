/**
 * test/types/consumer.mts — consumer-shaped typecheck fixture.
 *
 * Imports EVERY symbol declared by the hand-authored lib/*.d.mts files the
 * way a downstream strict-TS consumer (wicked-crew, wicked-garden qe) would,
 * and exercises the key signatures. `npm run typecheck` compiles this with
 * `tsc --noEmit` under strict nodenext resolution; if the declarations drift
 * from the surface this file uses, CI fails loudly.
 *
 * Type-check only — nothing here is ever executed (all usage lives inside
 * never-invoked functions).
 */

// --- Root barrel: every runtime symbol lib/index.mjs re-exports ---
import createDomainStoreDefault, {
  DomainStore,
  createDomainStore,
  SCHEMA_VERSION,
  __resetDomainStoreCacheForTests,
  QUERIES,
  QUERY_NAMES,
  routeQuestion,
  buildOracleQuery,
  supportedPatterns,
  buildManifest,
  MANIFEST_VERSION,
  VERDICT_VALUES,
  applyMigrations,
  listMigrations,
  emitBusEvent,
  domainEventToBusEvent,
  __resetBusAvailabilityForTests,
} from "wicked-ledger";

import type {
  // domain-store types
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
  // oracle types
  OracleQueryName,
  OracleQueryDef,
  OracleFilters,
  BuiltOracleQuery,
  // manifest types
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
  // migrate types
  SqliteDatabase,
  MigrationResult,
  MigrationInfo,
  // bus types
  LedgerBusEventType,
  LedgerBusEvent,
  DomainAction,
} from "wicked-ledger";

// --- Subpath entries resolve their own declarations ---
import dsDefault, { DomainStore as DS2, createDomainStore as cds2 } from "wicked-ledger/domain-store";
import oracleDefault, { buildOracleQuery as boq2, QUERIES as Q2 } from "wicked-ledger/oracle-queries";
import { buildManifest as bm2, VERDICT_VALUES as VV2, MANIFEST_VERSION as MV2 } from "wicked-ledger/manifest";
import { applyMigrations as am2, listMigrations as lm2 } from "wicked-ledger/migrate";
import { emitBusEvent as ebe2, domainEventToBusEvent as detbe2, __resetBusAvailabilityForTests as rba2 } from "wicked-ledger/bus-emit";

function expectType<T>(_value: T): void {}

// Never invoked — type-level assertions only.
export function _domainStoreSurface(): void {
  expectType<number>(SCHEMA_VERSION);

  const store: DomainStore = createDomainStore({ root: "/tmp/.wicked-qe" });
  expectType<DomainStore>(createDomainStore());
  expectType<DomainStore>(createDomainStoreDefault({ root: "." }));
  expectType<DomainStore>(dsDefault());
  expectType<DomainStore>(cds2());
  expectType<DomainStore>(new DS2("/tmp/root"));

  const verdict: VerdictRecord = store.create("verdicts", {
    run_id: "run-1",
    verdict: "PASS",
    reviewer: "acceptance-test-reviewer",
    reason: "all assertions held",
    vault_payload_sha: null,
  });
  expectType<Verdict>(verdict.verdict);
  expectType<0 | 1>(verdict.deleted);

  const run: RunRecord | null = store.get("runs", "some-id");
  if (run) {
    expectType<RunLifecycleStatus>(run.status);
    expectType<string>(run.scenario_id);
  }

  const scenarios: ScenarioRecord[] = store.list("scenarios", { project_id: "p-1" });
  expectType<string>(scenarios[0]!.format_version);

  const updated: TaskRecord | null = store.update("tasks", "t-1", { status: "done" });
  expectType<TaskStatus | undefined>(updated?.status);

  expectType<boolean>(store.delete("projects", "p-1"));
  expectType<ProjectRecord[]>(store.search("projects", "wicked", {}));
  expectType<StrategyRecord[]>(store.list("strategies"));
  expectType<number>(store.schemaVersion());
  store.rebuildIndex();

  const stats: DomainStoreStats = store.stats();
  if (stats.mode === "sqlite+json") expectType<number>(stats.schema_version);
  expectType<Record<TableName, number>>(stats.counts);
  expectType<StoreMode>(store.mode);
  store.close();
  __resetDomainStoreCacheForTests();

  // Generic helpers stay coherent.
  const createPayload: CreateInput<"runs"> = {
    project_id: "p",
    scenario_id: "s",
    started_at: new Date().toISOString(),
    status: "running",
  };
  expectType<CreateInput<"runs">>(createPayload);
  const diff: UpdateInput<"runs"> = { status: "passed", finished_at: new Date().toISOString() };
  expectType<UpdateInput<"runs">>(diff);
  const filter: ListParams<"verdicts"> = { run_id: "r-1" };
  expectType<ListParams<"verdicts">>(filter);
  expectType<BaseRecord>(verdict);
  expectType<TableRecordMap["projects"] extends ProjectRecord ? true : never>(true);
}

export function _oracleSurface(): void {
  const name: OracleQueryName | null = routeQuestion("what scenarios exist for my project?", { project: "demo" });
  expectType<OracleQueryName | null>(name);

  const def: OracleQueryDef = QUERIES.last_verdict_for_scenario;
  expectType<string>(def.description);
  expectType<readonly string[]>(def.params);
  expectType<readonly OracleQueryName[]>(QUERY_NAMES);

  const filters: OracleFilters = { scenario_name: "bootstrap", limit: 5 };
  const built: BuiltOracleQuery | null = buildOracleQuery("recent_runs", filters);
  if (built) {
    expectType<string>(built.sql);
    expectType<Array<string | number | null>>(built.params);
  }
  expectType<string>(supportedPatterns());
  expectType<typeof QUERIES>(Q2);
  expectType<BuiltOracleQuery | null>(boq2("row_counts"));
  expectType<typeof QUERIES>(oracleDefault.QUERIES);
}

export function _manifestSurface(): void {
  expectType<string>(MANIFEST_VERSION);
  expectType<string>(MV2);
  expectType<Verdict>(VERDICT_VALUES[0]);
  expectType<Verdict>(VV2[3]);

  const runRecord: BuildManifestRunRecord = {
    id: "run-1",
    project_id: "p-1",
    scenario_id: "s-1",
    started_at: "2026-08-11T00:00:00Z",
    finished_at: "2026-08-11T00:01:00Z",
    status: "passed",
  };
  const scenarioRecord: BuildManifestScenarioRecord = { id: "s-1", name: "export-csv" };
  const verdictRecord: BuildManifestVerdictRecord = {
    verdict: "PASS",
    reviewer: "acceptance-test-reviewer",
    equivalence: { method: "golden-master", matched: true },
  };
  const opts: BuildManifestOptions = {
    runRecord,
    scenarioRecord,
    verdictRecord,
    evidenceDir: "/tmp/evidence/run-1",
    qeVersion: "0.2.0",
    cli: "claude",
    excludeFiles: ["manifest.json"],
  };
  const { manifest, path } = buildManifest(opts);
  expectType<EvidenceManifest>(manifest);
  expectType<string>(path);
  expectType<RunStatus>(manifest.status);
  expectType<ManifestVerdict>(manifest.verdict);
  expectType<ManifestEnvironment>(manifest.environment);
  expectType<ManifestArtifact[]>(manifest.artifacts);
  expectType<ArtifactKind>(manifest.artifacts[0]!.kind);
  expectType<VerdictEquivalence | undefined>(manifest.verdict.equivalence);
  expectType<EquivalenceMethod | undefined>(manifest.verdict.equivalence?.method);
  expectType<ManifestAssertion[] | undefined>(manifest.assertions);
  expectType<{ manifest: EvidenceManifest; path: string }>(bm2(opts));

  // A DomainStore RunRecord/VerdictRecord feeds buildManifest directly.
  const row = null as unknown as RunRecord;
  const vrow = null as unknown as VerdictRecord;
  expectType<BuildManifestRunRecord>(row);
  expectType<BuildManifestVerdictRecord>(vrow);
}

export function _migrateSurface(): void {
  const db: SqliteDatabase = null as unknown as SqliteDatabase;
  const results: MigrationResult[] = applyMigrations(db, "/abs/path/lib/migrations");
  expectType<"applied" | "already_applied" | "skipped">(results[0]!.status);
  expectType<number>(results[0]!.version);
  const infos: MigrationInfo[] = listMigrations("/abs/path/lib/migrations");
  expectType<string>(infos[0]!.description);
  expectType<MigrationResult[]>(am2(db, "x"));
  expectType<MigrationInfo[]>(lm2("x"));
}

export function _busSurface(): void {
  expectType<boolean>(emitBusEvent("wicked.test.run.started", { run_id: "r-1" }));
  expectType<boolean>(ebe2("wicked.test.run.completed"));

  const action: DomainAction = "create";
  const ev = domainEventToBusEvent(action, "verdicts", { id: "v-1" }, "0.1.1");
  expectType<LedgerBusEvent | LedgerBusEvent[] | null>(ev);
  if (ev && !Array.isArray(ev)) {
    expectType<LedgerBusEventType>(ev.type);
    expectType<Record<string, unknown>>(ev.payload);
  }
  expectType<LedgerBusEvent | LedgerBusEvent[] | null>(detbe2("delete", "runs", null, "0.1.1"));
  __resetBusAvailabilityForTests();
  rba2();
}
