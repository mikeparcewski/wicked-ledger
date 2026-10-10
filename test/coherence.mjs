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
