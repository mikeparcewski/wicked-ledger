/**
 * Type declarations for lib/manifest.mjs — evidence-manifest builder.
 *
 * Hand-authored against the runtime module and the evidence-manifest schema
 * the builder is contractually bound to (schemas/evidence.json in wicked-vault
 * and docs/EVIDENCE.md — inherited from the retired wicked-testing package). Keep in lockstep with lib/manifest.mjs — CI runs
 * `npm run typecheck` against test/types/consumer.mts so drift fails loudly.
 */

/** Semver of the manifest schema this builder emits (e.g. "2.1.0"). */
export const MANIFEST_VERSION: string;

/**
 * Single source of truth for the claim-level taxonomy (manifest 2.1):
 * what a PASS is allowed to claim.
 * - "certified" — the user journey itself was exercised and verified
 * - "machinery-verified" — a disclosed proxy (e.g. API-substituted step)
 *   verified the machinery, not the journey
 * - "skipped" — the leg was not executed (disclosed)
 */
export const CLAIM_LEVELS: readonly ["certified", "machinery-verified", "skipped"];

/** A claim level: "certified" | "machinery-verified" | "skipped". */
export type ClaimLevel = (typeof CLAIM_LEVELS)[number];

/**
 * Single source of truth for the verdict enum. Matches
 * schemas/evidence.json `verdict.value` and the CHECK constraint in
 * lib/migrations/002_verdict_check_and_equivalence.sql.
 */
export const VERDICT_VALUES: readonly ["PASS", "FAIL", "PARTIAL", "CONDITIONAL", "INCONCLUSIVE", "N-A", "SKIP"];

/** A verdict value: "PASS" | "FAIL" | "PARTIAL" | "CONDITIONAL" | "INCONCLUSIVE" | "N-A" | "SKIP". */
export type Verdict = (typeof VERDICT_VALUES)[number];

/** Terminal run status accepted by the manifest (schemas/evidence.json `status`). */
export type RunStatus = "passed" | "failed" | "partial" | "inconclusive" | "errored" | "skipped";

/**
 * Lifecycle status of a `runs` row: "running" while in flight, then a
 * terminal RunStatus. buildManifest() rejects a manifest whose run is still
 * "running" (validateShape throws) — finish the run first.
 */
export type RunLifecycleStatus = RunStatus | "running";

/** Baseline-match method (schemas/evidence.json verdict.equivalence.method). */
export type EquivalenceMethod = "golden-master" | "contract" | "reconciliation" | "perceptual";

/**
 * Optional baseline-match facet on a verdict. Present when a
 * behavior-preserving change was judged against a captured baseline.
 */
export interface VerdictEquivalence {
  method: EquivalenceMethod;
  /** Whether the fresh output matched the baseline within tolerance. */
  matched: boolean;
  /** Path or identifier of the captured baseline artifact. */
  baseline_ref?: string;
  /** Lowercase hex SHA-256 of the baseline, for provenance. */
  baseline_sha?: string;
  /** Number of differences found vs. the baseline (integer >= 0). */
  diff_count?: number;
  /** Allowed diff threshold; matched is true when diff_count <= tolerance. */
  tolerance?: number;
}

/** Artifact kind classification (schemas/evidence.json artifacts[].kind). */
export type ArtifactKind =
  | "screenshot"
  | "video"
  | "http-response"
  | "http-request"
  | "log"
  | "stack-trace"
  | "metric"
  | "trace"
  | "coverage"
  | "diff"
  | "misc";

/** One evidence artifact row in the manifest. */
export interface ManifestArtifact {
  name: string;
  kind: ArtifactKind;
  /** Path relative to manifest.json. */
  path: string;
  bytes: number;
  /** Lowercase hex SHA-256 of the artifact content. */
  sha256: string;
  /** ISO-8601 capture timestamp (file mtime). */
  captured_at: string;
}

/** Environment block of the manifest. */
export interface ManifestEnvironment {
  os: string;
  node?: string;
  cli?: string;
  /** QE toolchain version (was `wicked_testing_version` in manifest 1.x). */
  qe_version: string;
}

/** The recorded verdict block of the manifest. */
export interface ManifestVerdict {
  value: Verdict;
  reviewer: string;
  reason?: string;
  /** ISO-8601 timestamp the verdict was recorded. */
  recorded_at: string;
  equivalence?: VerdictEquivalence;
}

/** Optional per-assertion outcome row (schemas/evidence.json `assertions`). */
export interface ManifestAssertion {
  id: string;
  description: string;
  passed: boolean;
  expected?: string;
  actual?: string;
}

/** One leg of a scenario's evidence with its own claim level (manifest 2.1). */
export interface ScenarioEvidenceLeg {
  /** Leg name, e.g. "ui", "acceptance", "archive-with-note". */
  leg: string;
  claim_level: ClaimLevel;
  /** Why the leg is capped/skipped (disclosed substitutions). */
  reason?: string;
}

/**
 * Manifest-2.1 scenario_evidence block: the campaign evidence shape proven by
 * the 2026-08 studio E2E campaign (8 keys) plus the first-class claim_level.
 * `status` is the EXECUTOR'S CLAIM (verdict taxonomy) — never the verdict of
 * record; the manifest's top-level `verdict` block stays that. The overall
 * claim_level may never be stronger than the weakest leg in `legs`
 * (validated — certify the journey, not the proxy).
 */
export interface ScenarioEvidence {
  /** Scenario title/identifier as executed. */
  scenario: string;
  /** Executor's claim, in the verdict taxonomy. */
  status: Verdict;
  /** Overall claim level for the scenario (floor of the legs). */
  claim_level: ClaimLevel;
  ui_steps?: string[];
  screenshots?: string[];
  wire_evidence?: Record<string, unknown> | string;
  db_evidence?: Record<string, unknown> | string;
  terminal_state_proof?: string;
  notes?: string | string[];
  /** Per-leg claim levels (e.g. an API-substituted acceptance leg). */
  legs?: ScenarioEvidenceLeg[];
}

/**
 * The public evidence manifest — the one artifact downstream consumers
 * (crew gates, dashboards) read. Written to
 * `<ledger-root>/evidence/<run-id>/manifest.json` (root `.wicked-qe/`, or a
 * legacy `.wicked-testing/`).
 */
export interface EvidenceManifest {
  manifest_version: string;
  run_id: string;
  project_id: string;
  scenario_id: string;
  scenario_name: string;
  scenario_path?: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: RunStatus;
  verdict: ManifestVerdict;
  environment: ManifestEnvironment;
  artifacts: ManifestArtifact[];
  /** Not emitted by buildManifest(); allowed by the schema for other producers. */
  assertions?: ManifestAssertion[];
  /** Optional manifest-2.1 campaign evidence block. Absent on 2.0 bundles. */
  scenario_evidence?: ScenarioEvidence;
}

/**
 * `runs` row subset consumed by buildManifest(). A DomainStore RunRecord
 * satisfies this. project_id / scenario_id / started_at are required — the
 * manifest schema requires them, and an undefined value would silently drop
 * the key from the written manifest.json.
 */
export interface BuildManifestRunRecord {
  id: string;
  project_id: string;
  scenario_id: string;
  started_at: string;
  /** May be absent on errored/crashed runs; duration_ms falls back to 0. */
  finished_at?: string | null;
  /** Defaults to "errored" when absent. Must be a terminal RunStatus by manifest time; "running" fails shape validation. */
  status?: RunLifecycleStatus;
  evidence_path?: string | null;
}

/** `scenarios` row subset consumed by buildManifest(). */
export interface BuildManifestScenarioRecord {
  id?: string;
  name?: string;
  source_path?: string | null;
}

/**
 * `verdicts` row subset consumed by buildManifest(). The optional
 * baseline-match facet may arrive either as `equivalence` (a plain object)
 * or `equivalence_json` (the DB column — a JSON string); either form is
 * normalized into the manifest's `verdict.equivalence` block, and a
 * malformed facet is dropped rather than throwing.
 */
export interface BuildManifestVerdictRecord {
  verdict: Verdict;
  reviewer?: string | null;
  reason?: string | null;
  created_at?: string;
  equivalence_json?: string | null;
  equivalence?: unknown;
}

export interface BuildManifestOptions {
  runRecord: BuildManifestRunRecord;
  scenarioRecord?: BuildManifestScenarioRecord | null;
  verdictRecord: BuildManifestVerdictRecord;
  /** Absolute path to the run's evidence dir (created if absent). */
  evidenceDir: string;
  /** QE toolchain version — lands in environment.qe_version. */
  qeVersion?: string;
  /** Legacy alias for qeVersion (pre-6c callers); one of the two is required. */
  wickedTestingVersion?: string;
  /** Optional host CLI name ("claude", "gemini", ...). */
  cli?: string;
  /** Basenames to skip in the artifacts walk. Default: ["manifest.json", "context.md"]. */
  excludeFiles?: string[];
  /**
   * Optional manifest-2.1 scenario_evidence block. Unlike the equivalence
   * facet, a malformed block makes buildManifest THROW (it is the campaign's
   * payload of record — fail loud, never silently drop it).
   */
  scenarioEvidence?: ScenarioEvidence;
}

/**
 * Build, shape-validate, and write `manifest.json` into the evidence dir.
 * Throws on missing required inputs or schema-shape drift (fail loud).
 *
 * @returns the manifest object and the absolute path it was written to.
 */
export function buildManifest(opts: BuildManifestOptions): { manifest: EvidenceManifest; path: string };

/** One contract violation reported by validateManifest(). */
export interface ManifestViolation {
  /** Dotted path of the offending field, e.g. "scenario_evidence.claim_level". */
  field: string;
  message: string;
}

/**
 * Validate an evidence manifest against the contract
 * (docs/SCHEMA-CONTRACT.md, "The evidence-manifest contract"). Non-throwing —
 * the reviewer-side entry point: validate a bundle BEFORE grading it, and
 * grade a schema-fail bundle INCONCLUSIVE (never PASS/FAIL). A 2.0.0 manifest
 * (no scenario_evidence block) validates clean; 2.1 rules apply only when the
 * block is present. Accepts unknown input by design (`m` may come off disk).
 */
export function validateManifest(m: unknown): { ok: boolean; violations: ManifestViolation[] };
