/**
 * lib/manifest.mjs — builds the public evidence manifest.
 *
 * Writes `<ledger-root>/evidence/<run-id>/manifest.json` (the root is
 * `.wicked-qe/` — or a legacy `.wicked-testing/` — see domain-store.mjs
 * resolveLedgerRoot) per the contract
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

// 2.1.0 (TH-5, qe campaign): added the OPTIONAL scenario_evidence block —
// the 8-key campaign evidence shape ({scenario, status, ui_steps,
// screenshots, wire_evidence, db_evidence, terminal_state_proof, notes})
// plus a first-class claim_level enum (certified | machinery-verified |
// skipped), overall and per leg. Minor bump (optional-field addition) per
// the manifest-contract rules in docs/SCHEMA-CONTRACT.md: 2.0.0 manifests
// on disk stay valid — consumers gate on the major and treat minors as
// additive. Reviewers validate a bundle (validateManifest) BEFORE grading;
// a schema-fail bundle grades INCONCLUSIVE, never PASS/FAIL.
// 2.0.0 (Phase 6c retirement): environment.wicked_testing_version renamed to
// environment.qe_version — a REQUIRED-field rename, hence the major bump.
// Consumers gate on manifest_version: 1.x manifests on
// disk keep the old key; 2.x manifests carry qe_version.
// 1.1.0: added the optional verdict.equivalence facet (baseline-match
// provenance) — minor bump (optional-field addition).
export const MANIFEST_VERSION = "2.1.0";

// Single source of truth for the claim-level taxonomy (manifest 2.1). The
// honest-caps doctrine made first-class: what a PASS is allowed to claim.
//   certified          — the user journey itself was exercised and verified
//   machinery-verified — a disclosed proxy (e.g. an API-substituted step)
//                        verified the machinery, not the journey
//   skipped            — the leg was not executed (disclosed)
// Campaign plans (wicked-garden schemas/campaign-recon.schema.json) may only
// PLAN ceilings of certified | machinery-verified; skipped is outcome-only.
export const CLAIM_LEVELS = Object.freeze([
  "certified", "machinery-verified", "skipped",
]);

// Strength order for the honest-cap invariant: a scenario-level claim can
// never be STRONGER than its weakest leg (certify the journey, not the proxy).
const CLAIM_RANK = { "certified": 2, "machinery-verified": 1, "skipped": 0 };

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
 * @param {string} opts.qeVersion  QE toolchain version, e.g. "0.2.0" — lands
 *   in environment.qe_version. (`wickedTestingVersion` is accepted as a
 *   legacy alias for one release cycle.)
 * @param {string} [opts.cli]          optional host CLI name ("claude", "gemini", ...)
 * @param {string[]} [opts.excludeFiles] basenames to skip in the artifacts walk
 * @param {object} [opts.scenarioEvidence] optional manifest-2.1 scenario_evidence
 *   block (the campaign 8-key shape + claim_level, optionally per-leg claims in
 *   legs[]). Unlike the equivalence facet, a malformed block THROWS instead of
 *   being dropped — it is the campaign's payload of record, and silently losing
 *   it would let a bundle pass gates while missing its evidence. Producers fail
 *   loud; reviewers reading a written manifest use validateManifest() and grade
 *   a schema-fail as INCONCLUSIVE.
 * @returns {{ manifest: object, path: string }}
 */
export function buildManifest({
  runRecord,
  scenarioRecord,
  verdictRecord,
  evidenceDir,
  qeVersion,
  wickedTestingVersion, // legacy alias (pre-6c callers) — remove next major
  cli,
  excludeFiles = ["manifest.json", "context.md"],
  scenarioEvidence,
}) {
  const producerVersion = qeVersion ?? wickedTestingVersion;
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
      qe_version: producerVersion,
    },
    artifacts,
    ...(scenarioEvidence != null ? { scenario_evidence: scenarioEvidence } : {}),
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

const STATUS_VALUES = ["passed", "failed", "partial", "inconclusive", "errored", "skipped"];

const _isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const _isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

// Validate the manifest-2.1 scenario_evidence block (only called when the key
// is present). Required trio: scenario, status (verdict taxonomy — the
// executor's CLAIM, never the verdict of record), claim_level. The remaining
// campaign keys (ui_steps, screenshots, wire_evidence, db_evidence,
// terminal_state_proof, notes) are optional but type-checked; unknown extra
// keys are tolerated (additive doctrine — a newer writer never breaks an
// older reader). legs[] carries per-leg claim levels; the honest-cap
// invariant rejects a scenario-level claim stronger than its weakest leg.
function validateScenarioEvidence(se, bad) {
  const P = "scenario_evidence";
  if (!_isPlainObject(se)) {
    bad(P, "must be an object");
    return;
  }
  if (typeof se.scenario !== "string" || !se.scenario) {
    bad(`${P}.scenario`, "required non-empty string");
  }
  if (!VERDICT_VALUES.includes(se.status)) {
    bad(`${P}.status`, `invalid executor claim '${se.status}' (expected one of ${VERDICT_VALUES.join("|")})`);
  }
  if (!CLAIM_LEVELS.includes(se.claim_level)) {
    bad(`${P}.claim_level`, `invalid claim_level '${se.claim_level}' (expected one of ${CLAIM_LEVELS.join("|")})`);
  }
  for (const k of ["ui_steps", "screenshots"]) {
    if (k in se && !_isStringArray(se[k])) bad(`${P}.${k}`, "must be an array of strings");
  }
  for (const k of ["wire_evidence", "db_evidence"]) {
    if (k in se && !_isPlainObject(se[k]) && typeof se[k] !== "string") {
      bad(`${P}.${k}`, "must be an object or a string");
    }
  }
  if ("terminal_state_proof" in se && typeof se.terminal_state_proof !== "string") {
    bad(`${P}.terminal_state_proof`, "must be a string");
  }
  if ("notes" in se && typeof se.notes !== "string" && !_isStringArray(se.notes)) {
    bad(`${P}.notes`, "must be a string or an array of strings");
  }
  if ("legs" in se) {
    if (!Array.isArray(se.legs)) {
      bad(`${P}.legs`, "must be an array");
      return;
    }
    se.legs.forEach((leg, i) => {
      if (!_isPlainObject(leg)) {
        bad(`${P}.legs[${i}]`, "must be an object");
        return;
      }
      if (typeof leg.leg !== "string" || !leg.leg) bad(`${P}.legs[${i}].leg`, "required non-empty string");
      if (!CLAIM_LEVELS.includes(leg.claim_level)) {
        bad(`${P}.legs[${i}].claim_level`, `invalid claim_level '${leg.claim_level}' (expected one of ${CLAIM_LEVELS.join("|")})`);
      }
      if ("reason" in leg && typeof leg.reason !== "string") bad(`${P}.legs[${i}].reason`, "must be a string");
    });
    // Honest-cap invariant: certify the journey, not the proxy. The overall
    // claim may self-cap FURTHER than the legs, never claim more.
    const legRanks = se.legs
      .filter(_isPlainObject)
      .map((l) => CLAIM_RANK[l.claim_level])
      .filter((r) => r !== undefined);
    const overall = CLAIM_RANK[se.claim_level];
    if (legRanks.length > 0 && overall !== undefined && overall > Math.min(...legRanks)) {
      bad(`${P}.claim_level`, `claim_level '${se.claim_level}' is stronger than the weakest leg`);
    }
  }
}

/**
 * Validate an evidence manifest against the contract (docs/SCHEMA-CONTRACT.md,
 * "The evidence-manifest contract"). Non-throwing — returns
 * `{ ok, violations: [{field, message}] }` so reviewers can validate a bundle
 * BEFORE grading it: a schema-fail bundle grades INCONCLUSIVE (deny-dominates
 * gates already treat that as not-satisfied), never PASS/FAIL.
 *
 * Backward-compatible by construction: a 2.0.0 manifest (no scenario_evidence
 * block) validates clean; the 2.1 rules apply only when the block is present.
 * Unknown top-level keys are tolerated (additive doctrine). Not a full
 * JSON-schema validator — asserts required keys, enums, and the shapes
 * consumers actually read, without adding an ajv dependency.
 */
export function validateManifest(m) {
  const violations = [];
  const bad = (field, message) => violations.push({ field, message });

  if (!_isPlainObject(m)) {
    bad("$", "manifest must be an object");
    return { ok: false, violations };
  }

  const required = [
    "manifest_version", "run_id", "project_id", "scenario_id", "scenario_name",
    "started_at", "finished_at", "duration_ms", "status", "verdict",
    "environment", "artifacts",
  ];
  for (const k of required) {
    if (!(k in m)) bad(k, `missing required field '${k}'`);
  }
  if ("manifest_version" in m && !/^\d+\.\d+\.\d+$/.test(m.manifest_version)) {
    bad("manifest_version", "invalid manifest_version");
  }
  if ("status" in m && !STATUS_VALUES.includes(m.status)) {
    bad("status", `invalid status '${m.status}'`);
  }
  if ("verdict" in m) {
    if (!_isPlainObject(m.verdict)) {
      bad("verdict", "must be an object");
    } else {
      if (!VERDICT_VALUES.includes(m.verdict.value)) {
        bad("verdict.value", `invalid verdict.value '${m.verdict.value}'`);
      }
      // Optional baseline-match facet: validate only when present. Mirrors
      // schemas/evidence.json verdict.equivalence (required method + matched).
      if ("equivalence" in m.verdict) {
        const eq = m.verdict.equivalence;
        if (!_isPlainObject(eq)) {
          bad("verdict.equivalence", "must be an object");
        } else {
          if (!EQUIVALENCE_METHODS.includes(eq.method)) bad("verdict.equivalence.method", `invalid verdict.equivalence.method '${eq.method}'`);
          if (typeof eq.matched !== "boolean") bad("verdict.equivalence.matched", "must be a boolean");
        }
      }
    }
  }
  if ("artifacts" in m) {
    if (!Array.isArray(m.artifacts)) {
      bad("artifacts", "must be an array");
    } else {
      m.artifacts.forEach((a, i) => {
        if (!_isPlainObject(a)) {
          bad(`artifacts[${i}]`, "must be an object");
          return;
        }
        for (const k of ["name", "kind", "path", "bytes", "sha256", "captured_at"]) {
          if (!(k in a)) bad(`artifacts[${i}].${k}`, `artifact missing '${k}'`);
        }
      });
    }
  }
  // 2.1: optional scenario_evidence block — validated only when present, so
  // 2.0 bundles stay valid.
  if ("scenario_evidence" in m) validateScenarioEvidence(m.scenario_evidence, bad);

  return { ok: violations.length === 0, violations };
}

// Producer-side gate: buildManifest fails loud on any violation so a
// nonconforming manifest is never written to disk.
function validateShape(m) {
  const { ok, violations } = validateManifest(m);
  if (!ok) {
    throw new Error(`manifest: ${violations.map((v) => `${v.field}: ${v.message}`).join("; ")}`);
  }
}
