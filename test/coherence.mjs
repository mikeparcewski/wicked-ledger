/**
 * test/coherence.mjs — JSON/index coherence invariants against the REAL
 * better-sqlite3 index (codex audit 2026-10-09):
 *
 *   FND-LDG-01  update validates the full merged record before any write, an
 *               index write failure is surfaced (stats().index_coherent) and
 *               reads never serve the stale index row afterwards; reopening
 *               reconciles the index from canonical JSON.
 *   newer-index a DB stamped by a newer ledger makes the store refuse writes
 *               (typed error, nothing written) instead of degrading to
 *               JSON-only writes; reads still come from canonical JSON.
 *   FND-LDG-03  engines.node is not below better-sqlite3's declared floor.
 *
 * Zero framework — plain node:assert. Requires the native driver: this file
 * FAILS (not skips) when better-sqlite3 cannot load, because every case here
 * is about the native index.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { createDomainStore, __resetDomainStoreCacheForTests } from "../lib/index.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

process.env.WICKED_RUNTIME = "local";
process.env.PATH = "/nonexistent-wicked-ledger-test-bin"; // no bus emission

let failures = 0;
function check(label, fn) {
  try { fn(); process.stdout.write(`  ok - ${label}\n`); }
  catch (err) { failures++; process.stdout.write(`  FAIL - ${label}\n    ${err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n    ") : err}\n`); }
}
function throwsCode(fn, code) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught, `expected a throw with code ${code}`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
}
function freshStore() {
  __resetDomainStoreCacheForTests();
  const root = mkdtempSync(join(tmpdir(), "wicked-ledger-coherence-"));
  return { root, store: createDomainStore({ root }) };
}
function seed(store) {
  const project = store.create("projects", { name: "coherence" });
  const scenario = store.create("scenarios", { project_id: project.id, name: "s", format_version: "1.0" });
  const run = store.create("runs", { project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running" });
  const verdict = store.create("verdicts", { run_id: run.id, verdict: "PASS", reviewer: "coherence-test" });
  return { project, scenario, run, verdict };
}
const jsonOf = (root, source, id) => JSON.parse(readFileSync(join(root, source, `${id}.json`), "utf8"));
const indexRow = (root, source, id) => {
  const db = new Database(join(root, "wicked-qe.db"), { readonly: true });
  try { return db.prepare(`SELECT * FROM ${source} WHERE id = ?`).get(id); } finally { db.close(); }
};
// Silence the store's expected stderr diagnostics during fault injection.
function quiet(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = orig; }
}

process.stdout.write("FND-LDG-01 — merged-record validation before any write\n");
{
  const { root, store } = freshStore();
  assert.equal(store.mode, "sqlite+json", "native index must be active for this test");
  const { run, verdict } = seed(store);

  check("update to an out-of-enum verdict throws ERR_INVALID_VERDICT", () => {
    throwsCode(() => store.update("verdicts", verdict.id, { verdict: "BOGUS" }), "ERR_INVALID_VERDICT");
  });
  check("...and nothing was written: JSON, index and get() all still say PASS", () => {
    assert.equal(jsonOf(root, "verdicts", verdict.id).verdict, "PASS");
    assert.equal(indexRow(root, "verdicts", verdict.id).verdict, "PASS");
    assert.equal(store.get("verdicts", verdict.id).verdict, "PASS");
    assert.equal(store.stats().drift_count, 0);
  });
  check("update that nulls a required column (reviewer) throws ERR_INVALID_RECORD", () => {
    throwsCode(() => store.update("verdicts", verdict.id, { reviewer: null }), "ERR_INVALID_RECORD");
    assert.equal(jsonOf(root, "verdicts", verdict.id).reviewer, "coherence-test");
  });
  check("update cannot clear the verdict (null) — ERR_INVALID_VERDICT", () => {
    throwsCode(() => store.update("verdicts", verdict.id, { verdict: null }), "ERR_INVALID_VERDICT");
  });
  check("create without a required column (reviewer) throws, nothing written", () => {
    const before = readdirSync(join(root, "verdicts")).length;
    throwsCode(() => store.create("verdicts", { run_id: run.id, verdict: "PASS" }), "ERR_INVALID_RECORD");
    assert.equal(readdirSync(join(root, "verdicts")).length, before);
  });
  check("create with a dangling foreign key (run_id) throws, nothing written", () => {
    const before = readdirSync(join(root, "verdicts")).length;
    throwsCode(() => store.create("verdicts", { run_id: "no-such-run", verdict: "PASS", reviewer: "x" }), "ERR_INVALID_RECORD");
    assert.equal(readdirSync(join(root, "verdicts")).length, before);
  });
  check("update cannot rewrite the record id", () => {
    const res = store.update("verdicts", verdict.id, { id: "other-id", reason: "kept" });
    assert.equal(res.id, verdict.id);
    assert.equal(jsonOf(root, "verdicts", verdict.id).id, verdict.id);
  });
  check("update cannot null or rewrite store-managed fields (created_at, deleted)", () => {
    const before = jsonOf(root, "verdicts", verdict.id);
    store.update("verdicts", verdict.id, { created_at: null, deleted: null, deleted_at: "x" });
    const after = jsonOf(root, "verdicts", verdict.id);
    assert.equal(after.created_at, before.created_at);
    assert.equal(after.deleted, 0);
    assert.equal(after.deleted_at, null);
    assert.equal(store.stats().drift_count, 0);
  });
  check("a valid update still lands in JSON and the index (positive control)", () => {
    const res = store.update("verdicts", verdict.id, { verdict: "FAIL", reason: "regressed" });
    assert.equal(res.verdict, "FAIL");
    assert.equal(indexRow(root, "verdicts", verdict.id).verdict, "FAIL");
    assert.equal(store.get("verdicts", verdict.id).verdict, "FAIL");
    assert.equal(store.stats().index_coherent, true);
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("FND-LDG-01 — index failure after the JSON write never serves the stale row\n");
{
  const { root, store } = freshStore();
  const { run, verdict } = seed(store);
  // Fault injection at the real index: every UPDATE of verdicts aborts (stands
  // in for disk-full / a corrupt index page). JSON still succeeds.
  const db = new Database(join(root, "wicked-qe.db"));
  db.exec("CREATE TRIGGER inject_fault BEFORE UPDATE ON verdicts BEGIN SELECT RAISE(ABORT, 'injected index fault'); END;");
  db.close();

  const res = quiet(() => store.update("verdicts", verdict.id, { verdict: "FAIL", reason: "regressed" }));
  check("the canonical JSON write landed and the index kept the stale PASS (fault really injected)", () => {
    assert.equal(res.verdict, "FAIL");
    assert.equal(jsonOf(root, "verdicts", verdict.id).verdict, "FAIL");
    assert.equal(indexRow(root, "verdicts", verdict.id).verdict, "PASS");
  });
  check("stats() surfaces the incoherence (index_coherent=false, drift_count=1, index_state=drifted)", () => {
    const s = store.stats();
    assert.equal(s.index_coherent, false);
    assert.equal(s.index_state, "drifted");
    assert.equal(s.drift_count, 1);
  });
  check("get() returns the canonical FAIL, not the stale indexed PASS", () => {
    assert.equal(store.get("verdicts", verdict.id).verdict, "FAIL");
  });
  check("list() returns the canonical FAIL, not the stale indexed PASS", () => {
    const rows = store.list("verdicts", { run_id: run.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, "FAIL");
  });
  check("the drift marker is durable on disk for other processes", () => {
    assert.ok(existsSync(join(root, "index-drift.json")));
  });
  store.close();

  // Reopen after the fault clears: the store reconciles the index from JSON.
  const db2 = new Database(join(root, "wicked-qe.db"));
  db2.exec("DROP TRIGGER inject_fault;");
  db2.close();
  __resetDomainStoreCacheForTests();
  const reopened = createDomainStore({ root });
  check("reopening reconciles: index rebuilt from JSON, marker cleared, coherent", () => {
    assert.equal(indexRow(root, "verdicts", verdict.id).verdict, "FAIL");
    assert.equal(existsSync(join(root, "index-drift.json")), false);
    assert.equal(reopened.stats().index_coherent, true);
    assert.equal(reopened.list("verdicts", { run_id: run.id })[0].verdict, "FAIL");
  });
  reopened.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("FND-LDG-01 — interrupted JSON-first write (JSON advanced, index did not)\n");
{
  const { root, store } = freshStore();
  const { verdict } = seed(store);
  // Simulate a crash between step 1 (JSON) and step 2 (index) of a write by an
  // earlier process: canonical JSON moved on, the index row did not.
  const j = jsonOf(root, "verdicts", verdict.id);
  j.verdict = "FAIL"; j.updated_at = new Date(Date.now() + 1000).toISOString();
  writeFileSync(join(root, "verdicts", `${verdict.id}.json`), JSON.stringify(j));
  check("get() detects the divergence and serves canonical JSON (FAIL), flagging drift", () => {
    assert.equal(indexRow(root, "verdicts", verdict.id).verdict, "PASS");
    assert.equal(quiet(() => store.get("verdicts", verdict.id)).verdict, "FAIL");
    assert.equal(store.stats().index_coherent, false);
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("FND-LDG-01 — divergence with an unchanged updated_at, and a marker from another process\n");
{
  const { root, store } = freshStore();
  const { run, verdict } = seed(store);
  const j = jsonOf(root, "verdicts", verdict.id);
  j.verdict = "FAIL"; // same updated_at
  writeFileSync(join(root, "verdicts", `${verdict.id}.json`), JSON.stringify(j));
  check("get() compares every indexed column, not only updated_at", () => {
    assert.equal(quiet(() => store.get("verdicts", verdict.id)).verdict, "FAIL");
    assert.equal(store.stats().index_coherent, false);
  });
  store.close();
  __resetDomainStoreCacheForTests();
  const a = createDomainStore({ root }); // reconciles on open
  check("reopen reconciled the same-timestamp divergence", () => {
    assert.equal(a.stats().index_coherent, true);
    assert.equal(a.list("verdicts", { run_id: run.id })[0].verdict, "FAIL");
  });
  // Another process marks drift while this instance is open.
  writeFileSync(join(root, "index-drift.json"), JSON.stringify({ reason: "other process" }));
  const k = jsonOf(root, "verdicts", verdict.id);
  k.verdict = "PASS"; k.updated_at = new Date(Date.now() + 5000).toISOString();
  writeFileSync(join(root, "verdicts", `${verdict.id}.json`), JSON.stringify(k));
  check("an open instance honours another process's drift marker on list()", () => {
    assert.equal(a.list("verdicts", { run_id: run.id })[0].verdict, "PASS");
    assert.equal(a.stats().index_coherent, false);
  });
  a.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("FND-LDG-01 — crash window, fresh index beside JSON, uniqueness, stats()\n");
{
  const { root, store } = freshStore();
  const { project, run, verdict } = seed(store);
  check("duplicate project name is rejected before any write (UNIQUE)", () => {
    throwsCode(() => store.create("projects", { name: "coherence" }), "ERR_INVALID_RECORD");
    assert.equal(store.stats().drift_count, 0);
  });
  check("an update into a duplicate (project_id, name) scenario is rejected", () => {
    const other = store.create("scenarios", { project_id: project.id, name: "s2", format_version: "1.0" });
    throwsCode(() => store.update("scenarios", other.id, { name: "s" }), "ERR_INVALID_RECORD");
  });
  check("no intent files linger after successful writes", () => {
    const dir = join(root, ".index-intent");
    assert.ok(!existsSync(dir) || readdirSync(dir).length === 0);
  });
  // A writer that died after its JSON write and before its index write:
  // its intent file survives with a pid that is no longer alive.
  const j = jsonOf(root, "verdicts", verdict.id);
  j.verdict = "FAIL"; j.updated_at = new Date(Date.now() + 1000).toISOString();
  writeFileSync(join(root, "verdicts", `${verdict.id}.json`), JSON.stringify(j));
  writeFileSync(join(root, ".index-intent", "2147483646-dead-writer"), "");
  check("stats() reports the interrupted write before any read touched the row", () => {
    assert.equal(quiet(() => store.stats()).index_coherent, false);
  });
  check("list() serves canonical JSON after an interrupted write (stale intent)", () => {
    assert.equal(store.list("verdicts", { run_id: run.id })[0].verdict, "FAIL");
  });
  store.close();
  __resetDomainStoreCacheForTests();
  const again = createDomainStore({ root });
  check("reopen reconciles the interrupted write and clears the stale intent", () => {
    assert.equal(again.stats().index_coherent, true);
    assert.equal(indexRow(root, "verdicts", verdict.id).verdict, "FAIL");
    assert.equal(readdirSync(join(root, ".index-intent")).length, 0);
  });
  again.close();
  // Canonical JSON written while no index existed (a JSON-only process on a
  // fresh store): the first native open must index it, not trust an empty db.
  for (const f of ["wicked-qe.db", "wicked-qe.db-wal", "wicked-qe.db-shm"]) rmSync(join(root, f), { force: true });
  __resetDomainStoreCacheForTests();
  const fresh = createDomainStore({ root });
  check("a freshly created index beside existing JSON is rebuilt on open", () => {
    assert.equal(fresh.list("verdicts", { run_id: run.id }).length, 1);
    assert.equal(indexRow(root, "verdicts", verdict.id).verdict, "FAIL");
  });
  fresh.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("newer-index fallback — a newer-version DB refuses writes\n");
{
  const { root, store } = freshStore();
  const { run, verdict } = seed(store);
  store.close();
  const db = new Database(join(root, "wicked-qe.db"));
  db.prepare("INSERT INTO schema_migrations (version, applied_at, description) VALUES (99, ?, 'future')").run(new Date().toISOString());
  db.close();
  __resetDomainStoreCacheForTests();
  const older = quiet(() => createDomainStore({ root }));
  const countVerdicts = () => readdirSync(join(root, "verdicts")).length;
  const before = countVerdicts();
  check("create throws ERR_INDEX_NEWER_VERSION and writes nothing", () => {
    throwsCode(() => older.create("verdicts", { run_id: run.id, verdict: "PASS", reviewer: "x" }), "ERR_INDEX_NEWER_VERSION");
    assert.equal(countVerdicts(), before);
  });
  check("update throws ERR_INDEX_NEWER_VERSION and leaves the JSON untouched", () => {
    throwsCode(() => older.update("verdicts", verdict.id, { verdict: "FAIL" }), "ERR_INDEX_NEWER_VERSION");
    assert.equal(jsonOf(root, "verdicts", verdict.id).verdict, "PASS");
  });
  check("delete throws ERR_INDEX_NEWER_VERSION", () => {
    throwsCode(() => older.delete("verdicts", verdict.id), "ERR_INDEX_NEWER_VERSION");
    assert.equal(jsonOf(root, "verdicts", verdict.id).deleted, 0);
  });
  check("reads still work from canonical JSON, and stats() names the reason", () => {
    assert.equal(older.get("verdicts", verdict.id).verdict, "PASS");
    const s = older.stats();
    assert.equal(s.index_state, "newer-version");
    assert.equal(s.writable, false);
  });
  older.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — get/list/search return the canonical record's stamps beyond the schema columns\n");
{
  const { root, store } = freshStore();
  assert.equal(store.mode, "sqlite+json", "native index must be active for this test");
  const project = store.create("projects", { name: "stamps" });
  const scenario = store.create("scenarios", { project_id: project.id, name: "s", format_version: "1.0" });
  const started_at = new Date().toISOString();
  // Shaped like a governed QE run (crew run 714675e5): the run and its verdict carry the
  // crew run id, the verdict the isolated review session. Neither has a schema column.
  const runA = store.create("runs", { project_id: project.id, scenario_id: scenario.id, started_at, status: "running", crew_run_id: "crew-run-A" });
  const runB = store.create("runs", { project_id: project.id, scenario_id: scenario.id, started_at, status: "running", crew_run_id: "crew-run-B" });
  const verdictA = store.create("verdicts", { run_id: runA.id, verdict: "PASS", reviewer: "acceptance-test-reviewer", review_session: "sess-A", crew_run_id: "crew-run-A" });
  // An old record written before any stamp existed.
  const legacy = store.create("runs", { project_id: project.id, scenario_id: scenario.id, started_at, status: "running" });

  check("the index is coherent, so reads below are index-served (not the JSON fallback)", () => {
    assert.equal(store.stats().index_coherent, true);
    assert.equal(existsSync(join(root, "index-drift.json")), false);
  });
  check("get('runs') carries crew_run_id", () => {
    assert.equal(store.get("runs", runA.id).crew_run_id, "crew-run-A");
    assert.equal(store.get("runs", runB.id).crew_run_id, "crew-run-B");
  });
  check("get('verdicts') carries review_session and crew_run_id", () => {
    const v = store.get("verdicts", verdictA.id);
    assert.equal(v.review_session, "sess-A");
    assert.equal(v.crew_run_id, "crew-run-A");
  });
  check("additive: every index column is still served exactly as the index holds it", () => {
    for (const [source, id] of [["runs", runA.id], ["verdicts", verdictA.id], ["runs", legacy.id]]) {
      const got = store.get(source, id);
      const row = indexRow(root, source, id);
      for (const [col, val] of Object.entries(row)) assert.strictEqual(got[col], val, `${source}.${col}`);
    }
    assert.strictEqual(store.get("runs", runA.id).finished_at, null, "an unset column is still null, not undefined");
  });
  check("an old record without the stamp reads back without one (nothing invented)", () => {
    const r = store.get("runs", legacy.id);
    assert.equal(Object.hasOwn(r, "crew_run_id"), false);
    assert.equal(Object.hasOwn(r, "review_session"), false);
  });
  check("list('verdicts', { run_id }) carries the stamps", () => {
    const rows = store.list("verdicts", { run_id: runA.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].review_session, "sess-A");
    assert.equal(rows[0].crew_run_id, "crew-run-A");
  });
  check("list('runs') gives each run its own stamp (no cross-record attribution)", () => {
    const byId = Object.fromEntries(store.list("runs").map((r) => [r.id, r]));
    assert.equal(byId[runA.id].crew_run_id, "crew-run-A");
    assert.equal(byId[runB.id].crew_run_id, "crew-run-B");
    assert.equal(Object.hasOwn(byId[legacy.id], "crew_run_id"), false);
    assert.strictEqual(byId[runA.id].finished_at, null);
  });
  check("search() (list-backed) carries the stamps", () => {
    assert.equal(store.search("runs", null, { project_id: project.id }).find((r) => r.id === runA.id).crew_run_id, "crew-run-A");
  });
  check("a stamp that is no column cannot be used as a list filter (allowlist unchanged)", () => {
    assert.equal(store.list("runs", { crew_run_id: "crew-run-A" }).length, 3);
  });
  check("...and still no drift after all the reads", () => {
    assert.equal(store.stats().index_coherent, true);
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — list() never serves an index row its canonical JSON contradicts\n");
{
  const { root, store } = freshStore();
  const { project, scenario, run } = seed(store);
  const other = store.create("runs", { project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running", crew_run_id: "crew-run-other" });
  // Out-of-band canonical change the index never saw: the run finished.
  const path = join(root, "runs", `${run.id}.json`);
  writeFileSync(path, JSON.stringify({ ...jsonOf(root, "runs", run.id), status: "passed" }));
  check("list filtered on the stale column answers from canonical JSON", () => {
    const rows = quiet(() => store.list("runs", { status: "running" }));
    assert.deepEqual(rows.map((r) => r.id), [other.id]);
    assert.equal(rows[0].crew_run_id, "crew-run-other");
  });
  check("...and marks drift durably", () => {
    assert.equal(store.stats().index_coherent, false);
    assert.equal(existsSync(join(root, "index-drift.json")), true);
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — list() drops a row whose canonical JSON is gone\n");
{
  const { root, store } = freshStore();
  const { run } = seed(store);
  rmSync(join(root, "runs", `${run.id}.json`));
  check("the index row is not served once its JSON is gone", () => {
    assert.deepEqual(quiet(() => store.list("runs")), []);
    assert.equal(store.stats().index_coherent, false);
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — index-served records: columns from the index, identity checked, extras from JSON\n");
{
  const { root, store } = freshStore();
  const { project, scenario, run } = seed(store);
  const stamped = store.create("runs", { project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running", crew_run_id: "canonical-A" });
  check("an agreeing column keeps the index's value and type (JSON reason 42 is served as the index's text)", () => {
    const v = store.create("verdicts", { run_id: run.id, verdict: "PASS", reviewer: "r", reason: 42, review_session: "s" });
    const indexed = indexRow(root, "verdicts", v.id).reason;
    assert.equal(typeof indexed, "string", "TEXT affinity stores the number as text");
    assert.strictEqual(store.get("verdicts", v.id).reason, indexed);
    assert.strictEqual(store.list("verdicts", { run_id: run.id }).find((x) => x.id === v.id).reason, indexed);
    assert.equal(store.get("verdicts", v.id).review_session, "s");
    assert.equal(store.stats().index_coherent, true);
  });
  check("an index column outside the schema cannot override a canonical stamp", () => {
    const db = new Database(join(root, "wicked-qe.db"));
    try {
      db.exec("ALTER TABLE runs ADD COLUMN crew_run_id TEXT");
      db.prepare("UPDATE runs SET crew_run_id = 'stale-index-B'").run();
    } finally { db.close(); }
    assert.equal(store.get("runs", stamped.id).crew_run_id, "canonical-A");
    assert.equal(store.list("runs").find((r) => r.id === stamped.id).crew_run_id, "canonical-A");
    assert.equal(Object.hasOwn(store.get("runs", run.id), "crew_run_id"), false, "an unstamped run gains no stamp from the index");
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — a record whose JSON names another id is not served\n");
{
  const { root, store } = freshStore();
  const { project, scenario } = seed(store);
  const r = store.create("runs", { id: "01", project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running" });
  // Hand-edited: same columns, but the file now claims id 1 and carries a stamp.
  writeFileSync(join(root, "runs", "01.json"), JSON.stringify({ ...jsonOf(root, "runs", r.id), id: 1, crew_run_id: "crew-1" }));
  check("indexed list('runs') (first read, index coherent) does not serve it, and marks drift", () => {
    assert.equal(store.stats().index_coherent, true);
    const rows = quiet(() => store.list("runs"));
    assert.equal(rows.some((x) => x.crew_run_id === "crew-1" || x.id === "01" || x.id === 1), false);
    assert.equal(existsSync(join(root, "index-drift.json")), true);
  });
  check("get('runs', '01') does not serve the forged stamp (JSON fallback)", () => {
    assert.equal(quiet(() => store.get("runs", "01")), null);
  });
  check("a rebuild indexes exactly what reads serve: coherent, and the file is still not a record", () => {
    quiet(() => store.rebuildIndex());
    assert.equal(store.stats().index_coherent, true);
    assert.equal(indexRow(root, "runs", "1"), undefined);
    assert.equal(indexRow(root, "runs", "01"), undefined);
    assert.equal(store.list("runs").some((x) => x.crew_run_id === "crew-1"), false);
    assert.equal(store.stats().index_coherent, true, "the next indexed read finds nothing to contradict");
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}
{
  const { root, store } = freshStore();
  const { project, scenario } = seed(store);
  store.create("runs", { id: "01", project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running" });
  writeFileSync(join(root, "runs", "01.json"), JSON.stringify({ ...jsonOf(root, "runs", "01"), id: 1, crew_run_id: "crew-1" }));
  check("indexed get('runs', '01') (first read) does not serve it, and marks drift", () => {
    assert.equal(quiet(() => store.get("runs", "01")), null);
    assert.equal(existsSync(join(root, "index-drift.json")), true);
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — ids are strings: create refuses others; a legacy numeric id is served from JSON only\n");
{
  const { root, store } = freshStore();
  const { project, scenario } = seed(store);
  const base = { project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running" };
  check("create refuses a numeric, zero or empty id (nothing written)", () => {
    const before = readdirSync(join(root, "runs")).length;
    for (const id of [1, 0, ""]) throwsCode(() => store.create("runs", { ...base, id }), "ERR_INVALID_RECORD");
    assert.equal(readdirSync(join(root, "runs")).length, before);
  });
  // A legacy record with a numeric id, written as an older ledger would have:
  // canonical 1.json { id: 1 }, and the index holds the id as better-sqlite3 binds it.
  const legacy = { ...base, id: 1, crew_run_id: "crew-A", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", deleted: 0, deleted_at: null };
  writeFileSync(join(root, "runs", "1.json"), JSON.stringify(legacy));
  const db = new Database(join(root, "wicked-qe.db"));
  let indexedId;
  try {
    db.prepare("INSERT INTO runs (id, project_id, scenario_id, started_at, status, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
      .run(1, base.project_id, base.scenario_id, base.started_at, base.status, legacy.created_at, legacy.updated_at);
    indexedId = db.prepare("SELECT id FROM runs WHERE id = ?").get(1)?.id;
  } finally { db.close(); }
  check("get(1) never merges the stamp under the index's other spelling of the id", () => {
    const got = quiet(() => store.get("runs", 1));
    assert.equal(got.crew_run_id, "crew-A");
    assert.equal(String(got.id), "1", `served id ${got.id} must be the canonical id (index held ${indexedId})`);
  });
  check("a rebuild does not re-declare coherence over it, and reads keep serving it from JSON", () => {
    throwsCode(() => quiet(() => store.rebuildIndex()), "ERR_REBUILD_INCOMPLETE");
    assert.equal(store.stats().index_coherent, false);
    assert.equal(store.list("runs").find((x) => String(x.id) === "1").crew_run_id, "crew-A");
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — an index row with no canonical JSON (null id) falls back, not truncates\n");
{
  const { root, store } = freshStore();
  const { project, scenario, run } = seed(store);
  const db = new Database(join(root, "wicked-qe.db"));
  try {
    db.pragma("foreign_keys = OFF");
    // Newest-first ordering puts this phantom row ahead of the real one.
    db.prepare("INSERT INTO runs (id, project_id, scenario_id, started_at, status, created_at, updated_at, deleted) VALUES (NULL, ?, ?, ?, 'running', '9999-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z', 0)")
      .run(project.id, scenario.id, new Date().toISOString());
  } finally { db.close(); }
  check("list('runs') serves the canonical runs and marks drift", () => {
    const rows = quiet(() => store.list("runs"));
    assert.deepEqual(rows.map((x) => x.id), [run.id]);
    assert.equal(store.stats().index_coherent, false);
    assert.equal(existsSync(join(root, "index-drift.json")), true);
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — create() with an explicit undefined id still mints one\n");
{
  const { root, store } = freshStore();
  const { project, scenario } = seed(store);
  const base = { project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running" };
  const a = store.create("runs", { ...base, id: undefined, crew_run_id: "crew-A" });
  const b = store.create("runs", { ...base, id: undefined, crew_run_id: "crew-B" });
  check("two creates get two distinct ids and two files (no shared undefined.json)", () => {
    assert.equal(typeof a.id, "string");
    assert.notEqual(a.id, b.id);
    assert.equal(existsSync(join(root, "runs", "undefined.json")), false);
    assert.equal(store.get("runs", a.id).crew_run_id, "crew-A");
    assert.equal(store.get("runs", b.id).crew_run_id, "crew-B");
    assert.equal(store.stats().index_coherent, true);
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("F23 — the JSON fallback (drifted index) still returns the stamps\n");
{
  const { root, store } = freshStore();
  const { project, scenario } = seed(store);
  const r = store.create("runs", { project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running", crew_run_id: "crew-F" });
  const db = new Database(join(root, "wicked-qe.db"));
  try { db.pragma("foreign_keys = OFF"); db.prepare("DELETE FROM runs WHERE id = ?").run(r.id); } finally { db.close(); }
  check("get() detects the missing row, marks drift and serves the stamped JSON", () => {
    assert.equal(quiet(() => store.get("runs", r.id)).crew_run_id, "crew-F");
    assert.equal(store.stats().index_coherent, false);
  });
  check("list() and search() on the fallback carry it too", () => {
    assert.equal(store.list("runs").find((x) => x.id === r.id).crew_run_id, "crew-F");
    assert.equal(store.search("runs", null).find((x) => x.id === r.id).crew_run_id, "crew-F");
  });
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("FND-LDG-03 — advertised Node floor vs the native driver\n");
{
  const floor = (range) => {
    const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(range).trim());
    assert.ok(m, `unparseable engines range '${range}'`);
    return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
  };
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  const ours = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
  const driver = require("better-sqlite3/package.json").engines.node;
  check(`engines.node '${ours}' is not below better-sqlite3's '${driver}'`, () => {
    assert.ok(cmp(floor(ours), floor(driver)) >= 0, `ledger advertises ${ours} but the required driver needs ${driver}`);
  });
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("README states the same Node floor as engines.node", () => {
    const major = floor(ours)[0];
    assert.ok(readme.includes(`Node \`>= ${major}\``), `README must say Node \`>= ${major}\``);
  });
}

if (failures > 0) {
  process.stdout.write(`\ncoherence: ${failures} FAILURE(S)\n`);
  process.exit(1);
}
process.stdout.write("\ncoherence: OK\n");
