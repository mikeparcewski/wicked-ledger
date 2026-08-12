/**
 * Type declarations for lib/manifest.mjs — evidence-manifest builder.
 *
 * Hand-authored against the runtime module and schemas the manifest is
 * contractually bound to (wicked-testing's schemas/evidence.json and
 * docs/EVIDENCE.md). Keep in lockstep with lib/manifest.mjs — CI runs
 * `npm run typecheck` against test/types/consumer.mts so drift fails loudly.
 */

/** Semver of the manifest schema this builder emits (e.g. "1.1.0"). */
export const MANIFEST_VERSION: string;

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
  wicked_testing_version: string;
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

/**
 * The public evidence manifest — the one artifact downstream consumers
 * (crew gates, dashboards) read. Written to
 * `.wicked-testing/evidence/<run-id>/manifest.json`.
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
}

/** `runs` row subset consumed by buildManifest(). A DomainStore RunRecord satisfies this. */
export interface BuildManifestRunRecord {
  id: string;
  project_id?: string;
  scenario_id?: string;
  started_at?: string | null;
  finished_at?: string | null;
  /** Must be a terminal RunStatus by manifest time; "running" fails shape validation. */
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
  /** e.g. "0.2.0" — lands in environment.wicked_testing_version. */
  wickedTestingVersion: string;
  /** Optional host CLI name ("claude", "gemini", ...). */
  cli?: string;
  /** Basenames to skip in the artifacts walk. Default: ["manifest.json", "context.md"]. */
  excludeFiles?: string[];
}

/**
 * Build, shape-validate, and write `manifest.json` into the evidence dir.
 * Throws on missing required inputs or schema-shape drift (fail loud).
 *
 * @returns the manifest object and the absolute path it was written to.
 */
export function buildManifest(opts: BuildManifestOptions): { manifest: EvidenceManifest; path: string };
