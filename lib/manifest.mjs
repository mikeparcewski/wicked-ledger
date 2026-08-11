/**
 * lib/manifest.mjs — builds the public evidence manifest.
 *
 * Writes `.wicked-testing/evidence/<run-id>/manifest.json` per the contract
 * in docs/EVIDENCE.md and schemas/evidence.json. The manifest is the one
 * artifact downstream consumers (wicked-garden crew gates, dashboards) read —
 * everything else in the evidence dir is referenced from the `artifacts[]`
 * entry in the manifest and never read directly.
 *
 * Input is the DomainStore records for the run; output is the manifest
 * object AND the path it was written to. Runs a minimal shape validation
 * before writing so we fail loud on schema drift.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { platform, release } from "node:os";

// 1.1.0: added the optional verdict.equivalence facet (baseline-match
// provenance). Minor bump per docs/EVIDENCE.md §7 — adds an optional field,
// no existing field changed or removed, readers ignoring unknown keys are
// unaffected.
export const MANIFEST_VERSION = "1.1.0";

// Single source of truth for the verdict enum. MUST stay identical to
// schemas/evidence.json `verdict.value` and the CHECK constraint in
// lib/migrations/002_verdict_check_and_equivalence.sql. validateShape() below
// and DomainStore's pre-write verdict guard (lib/domain-store.mjs) both import
// this so there is exactly one place to update when the taxonomy changes.
export const VERDICT_VALUES = Object.freeze([
  "PASS", "FAIL", "PARTIAL", "CONDITIONAL", "INCONCLUSIVE", "N-A", "SKIP",
]);

// Artifact kind classification. Every artifact ends up with a kind from this
// set because the schema's enum rejects anything else. Unknown extensions
// fall through to "misc" rather than being dropped.
const KIND_BY_EXT = {
  ".png": "screenshot", ".jpg": "screenshot", ".jpeg": "screenshot", ".gif": "screenshot",
  ".mp4": "video", ".webm": "video", ".mov": "video",
  ".log": "log",
  ".diff": "diff", ".patch": "diff",
};

function classifyArtifact(filename) {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  if (lower.includes("stack") || lower.includes("traceback")) return "stack-trace";
  if (lower.includes("coverage") || lower.endsWith(".lcov") || lower.endsWith(".cobertura")) return "coverage";
  if (lower.includes("trace")) return "trace";
  if (lower.includes("metric")) return "metric";
  if (lower.includes("response") && lower.endsWith(".json")) return "http-response";
  if (lower.includes("request") && lower.endsWith(".json")) return "http-request";
  return "misc";
}

// Valid equivalence-method values — must match schemas/evidence.json
// verdict.equivalence.method enum exactly.
const EQUIVALENCE_METHODS = ["golden-master", "contract", "reconciliation", "perceptual"];

// Coerce the optional baseline-match facet from a verdict record into the
// manifest's verdict.equivalence shape (or null if absent / unusable). Accepts
// either `equivalence` (object) or `equivalence_json` (JSON string from the DB
// column). Only the schema-known keys are carried; a malformed/incomplete
// facet returns null so the optional field is simply omitted rather than
// producing an invalid manifest.
function normalizeEquivalence(verdictRecord) {
  let raw = verdictRecord.equivalence;
  if (raw == null && typeof verdictRecord.equivalence_json === "string" && verdictRecord.equivalence_json.trim()) {
    try { raw = JSON.parse(verdictRecord.equivalence_json); } catch { return null; }
  }
  if (!raw || typeof raw !== "object") return null;
  // Required-by-schema fields. Without them the block can't validate, so drop it.
  if (typeof raw.matched !== "boolean") return null;
  if (!EQUIVALENCE_METHODS.includes(raw.method)) return null;
  const out = { method: raw.method, matched: raw.matched };
  if (typeof raw.baseline_ref === "string" && raw.baseline_ref) out.baseline_ref = raw.baseline_ref;
  if (typeof raw.baseline_sha === "string" && /^[a-f0-9]{64}$/.test(raw.baseline_sha)) out.baseline_sha = raw.baseline_sha;
  if (Number.isInteger(raw.diff_count) && raw.diff_count >= 0) out.diff_count = raw.diff_count;
  // Require a FINITE number: `typeof x === "number"` also accepts Infinity/NaN,
  // and `Infinity >= 0` is true — a non-finite tolerance would make any
  // diff_count "within tolerance". Infinity/NaN also serialize to `null`, which
  // violates the schema (number). Number.isFinite rejects both.
  if (Number.isFinite(raw.tolerance) && raw.tolerance >= 0) out.tolerance = raw.tolerance;
  // Producer-enforced invariant (NIT-4): the facet is the "verdict of record"
  // for equivalence, so a self-contradictory facet is worse than no facet.
  // When BOTH diff_count and tolerance are present, `matched` must equal
  // `diff_count <= tolerance`; otherwise drop the facet (consistent with the
  // "drop malformed → null" stance above) rather than persist a misleading one.
  if ("diff_count" in out && "tolerance" in out && out.matched !== (out.diff_count <= out.tolerance)) {
    return null;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.runRecord      runs row: { id, project_id, scenario_id, started_at, finished_at, status, evidence_path }
 * @param {object} opts.scenarioRecord scenarios row: { id, name, source_path? }
 * @param {object} opts.verdictRecord  verdicts row: { verdict, reviewer, reason?, created_at, equivalence_json?, equivalence? }
 *   The optional baseline-match facet may arrive either as `equivalence` (a
 *   plain object) or `equivalence_json` (the DB column — a JSON string). Either
 *   form is normalized into the manifest's `verdict.equivalence` block.
 * @param {string} opts.evidenceDir    absolute path to the run's evidence dir
 * @param {string} opts.wickedTestingVersion  e.g. "0.2.0"
 * @param {string} [opts.cli]          optional host CLI name ("claude", "gemini", ...)
 * @param {string[]} [opts.excludeFiles] basenames to skip in the artifacts walk
 * @returns {{ manifest: object, path: string }}
 */
export function buildManifest({
  runRecord,
  scenarioRecord,
  verdictRecord,
  evidenceDir,
  wickedTestingVersion,
  cli,
  excludeFiles = ["manifest.json", "context.md"],
}) {
  if (!runRecord || !runRecord.id) throw new Error("buildManifest: runRecord.id required");
  if (!verdictRecord || !verdictRecord.verdict) throw new Error("buildManifest: verdictRecord.verdict required");
  if (!evidenceDir) throw new Error("buildManifest: evidenceDir required");

  mkdirSync(evidenceDir, { recursive: true });

  const artifacts = collectArtifacts(evidenceDir, excludeFiles);

  // Normalize the optional baseline-match facet. Accept either a plain object
  // (`equivalence`) or the DB column form (`equivalence_json`, a JSON string).
  // A malformed JSON string is dropped rather than throwing — the facet is
  // optional and a broken sidecar must not sink an otherwise-valid manifest.
  const equivalence = normalizeEquivalence(verdictRecord);

  const started = runRecord.started_at ? new Date(runRecord.started_at).getTime() : null;
  const finished = runRecord.finished_at ? new Date(runRecord.finished_at).getTime() : null;
  const duration_ms = started !== null && finished !== null && finished >= started
    ? finished - started
    : 0;

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    run_id: runRecord.id,
    project_id: runRecord.project_id,
    scenario_id: runRecord.scenario_id,
    scenario_name: scenarioRecord?.name ?? "unknown",
    ...(scenarioRecord?.source_path ? { scenario_path: scenarioRecord.source_path } : {}),
    started_at: runRecord.started_at,
    finished_at: runRecord.finished_at,
    duration_ms,
    status: runRecord.status || "errored",
    verdict: {
      value: verdictRecord.verdict,
      reviewer: verdictRecord.reviewer || "unknown",
      ...(verdictRecord.reason ? { reason: verdictRecord.reason } : {}),
      recorded_at: verdictRecord.created_at || new Date().toISOString(),
      ...(equivalence ? { equivalence } : {}),
    },
    environment: {
      os: `${platform()} ${release()}`,
      node: process.versions.node,
      ...(cli ? { cli } : {}),
      wicked_testing_version: wickedTestingVersion,
    },
    artifacts,
  };

  validateShape(manifest);

  const path = join(evidenceDir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, path };
}

function collectArtifacts(evidenceDir, excludeFiles) {
  if (!existsSync(evidenceDir)) return [];
  const out = [];
  for (const name of readdirSync(evidenceDir)) {
    if (excludeFiles.includes(name)) continue;
    const full = join(evidenceDir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    let content;
    try { content = readFileSync(full); } catch { continue; }
    const sha = createHash("sha256").update(content).digest("hex");
    out.push({
      name,
      kind: classifyArtifact(name),
      path: name,
      bytes: st.size,
      sha256: sha,
      captured_at: new Date(st.mtimeMs).toISOString(),
    });
  }
  return out;
}

// Minimal shape check against schemas/evidence.json required fields. Not a
// full JSON-schema validator — just asserts top-level keys are present and
// types look right. Keeps us honest without adding an ajv dependency.
function validateShape(m) {
  const required = [
    "manifest_version", "run_id", "project_id", "scenario_id", "scenario_name",
    "started_at", "finished_at", "duration_ms", "status", "verdict",
    "environment", "artifacts",
  ];
  for (const k of required) {
    if (!(k in m)) throw new Error(`manifest: missing required field '${k}'`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(m.manifest_version)) throw new Error("manifest: invalid manifest_version");
  if (!["passed", "failed", "partial", "inconclusive", "errored", "skipped"].includes(m.status)) throw new Error(`manifest: invalid status '${m.status}'`);
  if (!VERDICT_VALUES.includes(m.verdict.value)) throw new Error(`manifest: invalid verdict.value '${m.verdict.value}'`);
  // Optional baseline-match facet: validate only when present. Mirrors
  // schemas/evidence.json verdict.equivalence (required method + matched).
  if ("equivalence" in m.verdict) {
    const eq = m.verdict.equivalence;
    if (!eq || typeof eq !== "object") throw new Error("manifest: verdict.equivalence must be an object");
    if (!EQUIVALENCE_METHODS.includes(eq.method)) throw new Error(`manifest: invalid verdict.equivalence.method '${eq.method}'`);
    if (typeof eq.matched !== "boolean") throw new Error("manifest: verdict.equivalence.matched must be a boolean");
  }
  if (!Array.isArray(m.artifacts)) throw new Error("manifest: artifacts must be array");
  for (const a of m.artifacts) {
    for (const k of ["name", "kind", "path", "bytes", "sha256", "captured_at"]) {
      if (!(k in a)) throw new Error(`manifest: artifact missing '${k}'`);
    }
  }
}
