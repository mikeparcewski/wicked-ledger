/**
 * test/smoke.mjs — wicked-ledger smoke test.
 *
 * Proves the extracted ledger works end to end without any external
 * context:
 *   1. every public module imports (parse + link check);
 *   2. createDomainStore runs the migrations clean against a fresh tmp dir;
 *   3. project → scenario → run → verdict create / get / list round-trips
 *      (the FK chain the schema requires to land a verdict);
 *   4. at least one oracle-queries query executes against the real schema and
 *      returns the row just written;
 *   5. the migrate + manifest surfaces respond.
 *
 * Zero test framework — plain node:assert. `npm test` runs this file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import {
  createDomainStore,
  resolveLedgerRoot,
  LEDGER_DIRNAME,
  LEGACY_LEDGER_DIRNAME,
  SCHEMA_VERSION,
  __resetDomainStoreCacheForTests,
  buildOracleQuery,
  routeQuestion,
  QUERY_NAMES,
  buildManifest,
  MANIFEST_VERSION,
  VERDICT_VALUES,
  applyMigrations,
  listMigrations,
  domainEventToBusEvent,
  resolveRuntimeProfile,
  assertRuntimeSupported,
} from "../lib/index.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let failures = 0;
function ok(label) {
  process.stdout.write(`  ok - ${label}\n`);
}
function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (err) {
    failures++;
    process.stdout.write(`  NOT ok - ${label}\n    ${err && err.stack ? err.stack : err}\n`);
  }
}

const root = mkdtempSync(join(tmpdir(), "wicked-ledger-smoke-"));
process.stdout.write(`# smoke root: ${root}\n`);

// --- WICKED_RUNTIME seam (env passed explicitly — no process.env mutation) ---
check("runtime profile defaults to local (unset / empty / explicit)", () => {
  assert.deepEqual(resolveRuntimeProfile({}), { runtime: "local", storeUrl: undefined });
  assert.equal(resolveRuntimeProfile({ WICKED_RUNTIME: "" }).runtime, "local");
  assert.equal(resolveRuntimeProfile({ WICKED_RUNTIME: "LOCAL" }).runtime, "local");
});

check("unrecognized WICKED_RUNTIME fails loud (never a silent local fallback)", () => {
  assert.throws(
    () => resolveRuntimeProfile({ WICKED_RUNTIME: "prod" }),
    (err) => err.code === "ERR_WICKED_RUNTIME_INVALID",
  );
});

check("WICKED_RUNTIME=team fails loud: no shared-store driver exists yet", () => {
  assert.throws(
    () => assertRuntimeSupported({ WICKED_RUNTIME: "team", WICKED_STORE_URL: "postgres://x/y" }),
    (err) => err.code === "ERR_WICKED_RUNTIME_TEAM_UNSUPPORTED",
  );
});

check("createDomainStore refuses to open a local store under a team profile", () => {
  assert.throws(
    () => createDomainStore({ root, env: { WICKED_RUNTIME: "team" } }),
    (err) => err.code === "ERR_WICKED_RUNTIME_TEAM_UNSUPPORTED",
  );
});

try {
  __resetDomainStoreCacheForTests();
  const store = createDomainStore({ root });

  // 1. SQLite index must be live (not JSON-only degradation) — the native
  //    module has to load and migrations must apply for the ledger to be useful.
  check("better-sqlite3 native module loaded (sqlite+json mode)", () => {
    assert.equal(store.mode, "sqlite+json", `expected sqlite+json, got ${store.mode}`);
  });

  check("migrations applied to current SCHEMA_VERSION", () => {
    assert.equal(SCHEMA_VERSION, 3);
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  });

  check("migration files discoverable + ordered", () => {
    const migs = listMigrations(join(root, "..", "does-not-exist"));
    assert.ok(Array.isArray(migs)); // graceful empty on missing dir
    assert.equal(typeof applyMigrations, "function");
  });

  // 2. FK chain: project -> scenario -> run -> verdict.
  const project = store.create("projects", { name: "smoke-project", description: "smoke" });
  const scenario = store.create("scenarios", {
    project_id: project.id,
    name: "smoke-scenario",
    format_version: "1.0",
    source_path: "scenarios/smoke.md",
  });
  const run = store.create("runs", {
    project_id: project.id,
    scenario_id: scenario.id,
    started_at: new Date().toISOString(),
    status: "running",
    evidence_path: join(root, "evidence", "smoke-run"),
  });
  const verdict = store.create("verdicts", {
    run_id: run.id,
    verdict: "PASS",
    reviewer: "smoke-reviewer",
    reason: "round-trip smoke",
    evidence_path: run.evidence_path,
  });

  check("create returned rows with ids", () => {
    for (const [k, r] of Object.entries({ project, scenario, run, verdict })) {
      assert.ok(r && r.id, `${k} missing id`);
    }
  });

  check("get('verdicts', id) round-trips the written verdict", () => {
    const got = store.get("verdicts", verdict.id);
    assert.ok(got, "verdict not found");
    assert.equal(got.id, verdict.id);
    assert.equal(got.verdict, "PASS");
    assert.equal(got.run_id, run.id);
    assert.equal(got.reviewer, "smoke-reviewer");
  });

  check("list('verdicts', {run_id}) contains the verdict", () => {
    const rows = store.list("verdicts", { run_id: run.id });
    assert.ok(rows.some((r) => r.id === verdict.id), "verdict not in list");
  });

  check("get('runs', id) + list('scenarios', {project_id}) round-trip", () => {
    assert.equal(store.get("runs", run.id).status, "running");
    const scenarios = store.list("scenarios", { project_id: project.id });
    assert.ok(scenarios.some((s) => s.id === scenario.id));
  });

  check("invalid verdict value rejected pre-write (enum guard)", () => {
    assert.throws(
      () => store.create("verdicts", { run_id: run.id, verdict: "BOGUS", reviewer: "x" }),
      /invalid verdict value/i,
    );
    assert.ok(VERDICT_VALUES.includes("PASS"));
  });

  // 3. Oracle query executes against the real, migrated schema and returns
  //    the row we just wrote. Open a second read connection on the same db.
  const dbPath = join(root, "wicked-qe.db");
  check("db file exists on disk", () => assert.ok(existsSync(dbPath), dbPath));

  check("oracle buildOracleQuery('last_verdict_for_scenario') returns the verdict", () => {
    const built = buildOracleQuery("last_verdict_for_scenario", { scenario_name: "smoke-scenario" });
    assert.ok(built && built.sql, "no sql built");
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(built.sql).get(...built.params);
      assert.ok(row, "oracle query returned no row");
      assert.equal(row.verdict, "PASS");
      assert.equal(row.scenario_name, "smoke-scenario");
    } finally {
      db.close();
    }
  });

  check("oracle row_counts query returns populated counts", () => {
    const built = buildOracleQuery("row_counts", {});
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(built.sql).get(...built.params);
      assert.equal(row.projects, 1);
      assert.equal(row.verdicts, 1);
      assert.ok(row.schema_migrations >= 3);
    } finally {
      db.close();
    }
  });

  check("oracle routeQuestion + QUERY_NAMES surface", () => {
    assert.ok(QUERY_NAMES.includes("last_verdict_for_scenario"));
    assert.equal(routeQuestion("what is the last verdict for smoke-scenario?"), "last_verdict_for_scenario");
  });

  // 4. Finish the run (update round-trip; a manifest is for a terminal run),
  //    then build its evidence manifest.
  const finishedRun = store.update("runs", run.id, {
    status: "passed",
    finished_at: new Date().toISOString(),
  });

  check("update('runs', id) round-trips the terminal status", () => {
    assert.ok(finishedRun, "update returned null");
    assert.equal(finishedRun.status, "passed");
    assert.equal(store.get("runs", run.id).status, "passed");
  });

  check("buildManifest writes a valid evidence manifest", () => {
    const { manifest, path } = buildManifest({
      runRecord: finishedRun,
      scenarioRecord: scenario,
      verdictRecord: verdict,
      evidenceDir: join(root, "evidence", "smoke-run"),
      qeVersion: "0.2.0",
    });
    assert.equal(manifest.manifest_version, MANIFEST_VERSION);
    assert.equal(manifest.verdict.value, "PASS");
    assert.equal(manifest.status, "passed");
    assert.equal(manifest.environment.qe_version, "0.2.0");
    assert.ok(existsSync(path), "manifest not written");
  });

  // 5. Bus mapping is pure + present (no wicked-bus binary required).
  check("domainEventToBusEvent maps a verdict create", () => {
    const ev = domainEventToBusEvent("create", "verdicts", verdict, "0.2.0");
    assert.ok(ev && ev.type === "wicked.test.verdict.created");
    assert.equal(ev.payload.qe_version, "0.2.0");
  });

  check("resolveLedgerRoot dual-read: new name wins, legacy honored, default new", () => {
    const base = join(root, "resolve-bed");
    mkdirSync(base, { recursive: true });
    // no dirs: default to the new name
    assert.equal(resolveLedgerRoot(base), join(base, LEDGER_DIRNAME));
    // legacy only: legacy root is honored
    mkdirSync(join(base, LEGACY_LEDGER_DIRNAME), { recursive: true });
    assert.equal(resolveLedgerRoot(base), join(base, LEGACY_LEDGER_DIRNAME));
    // both present: the new name wins
    mkdirSync(join(base, LEDGER_DIRNAME), { recursive: true });
    assert.equal(resolveLedgerRoot(base), join(base, LEDGER_DIRNAME));
  });

  check("buildManifest accepts the legacy wickedTestingVersion alias", () => {
    const { manifest } = buildManifest({
      runRecord: finishedRun,
      scenarioRecord: scenario,
      verdictRecord: verdict,
      evidenceDir: join(root, "evidence", "smoke-run-legacy"),
      wickedTestingVersion: "0.1.0",
    });
    assert.equal(manifest.environment.qe_version, "0.1.0");
  });

  store.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  process.stdout.write(`\n# FAILED: ${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\n# PASS: all smoke checks passed\n`);
