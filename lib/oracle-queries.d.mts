/**
 * Type declarations for lib/oracle-queries.mjs — the fixed parameterized
 * query library for test-oracle (no LLM-generated SQL).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/oracle-queries.mjs — CI runs `npm run typecheck` so drift fails loudly.
 */

/** The 13 named queries shipped by the library. */
export type OracleQueryName =
  | "scenarios_for_project"
  | "last_verdict_for_scenario"
  | "runs_by_status"
  | "failed_runs_since"
  | "tasks_by_status"
  | "tasks_for_project"
  | "current_strategy_for_project"
  | "recent_runs"
  | "verdicts_since"
  | "row_counts"
  | "schema_version"
  | "baseline_matches_for_scenario"
  | "most_recent_project";

export interface OracleQueryDef {
  /** Human-readable description of the question the query answers. */
  description: string;
  /**
   * Declared bind parameters in placeholder order. A trailing `?` marks an
   * optional parameter (e.g. "since?", "project?") whose clause is removed
   * when the caller does not supply it.
   */
  params: readonly string[];
  /** The parameterized SQL (may contain {{SINCE_CLAUSE}} / {{PROJECT_CLAUSE}} templates). */
  sql: string;
  /** Keywords used by routeQuestion() scoring. */
  keywords: readonly string[];
}

/** Named query definitions, keyed by query name. */
export const QUERIES: Readonly<Record<OracleQueryName, OracleQueryDef>>;

/** Object.keys(QUERIES). */
export const QUERY_NAMES: readonly OracleQueryName[];

/**
 * Filter values used by routeQuestion() overrides and buildOracleQuery()
 * parameter binding. Keys must match the names declared in each query's
 * `params` list (sans the optional `?` suffix).
 */
export interface OracleFilters {
  project?: string;
  project_name?: string;
  scenario_name?: string;
  status?: string;
  /** ISO-8601 date lower bound. */
  since?: string;
  /** Row cap for recent_runs. */
  limit?: number;
  [param: string]: string | number | undefined;
}

/**
 * Route a natural-language question to a named query by keyword matching.
 * Returns null when no query matches.
 */
export function routeQuestion(question: string, filters?: OracleFilters): OracleQueryName | null;

export interface BuiltOracleQuery {
  /** Final SQL with template clauses substituted. */
  sql: string;
  /**
   * Positional bind values in declared param order. A missing REQUIRED
   * param is pushed as null so the mismatch surfaces at .get()/.all() time.
   */
  params: Array<string | number | null>;
}

/**
 * Build a query with filter substitution. Returns null for an unknown
 * query name.
 */
export function buildOracleQuery(queryName: OracleQueryName | (string & {}), filterArgs?: OracleFilters): BuiltOracleQuery | null;

/** Human-readable list of supported question patterns (one per line). */
export function supportedPatterns(): string;

declare const _default: {
  QUERIES: typeof QUERIES;
  QUERY_NAMES: typeof QUERY_NAMES;
  routeQuestion: typeof routeQuestion;
  buildOracleQuery: typeof buildOracleQuery;
  supportedPatterns: typeof supportedPatterns;
};
export default _default;
