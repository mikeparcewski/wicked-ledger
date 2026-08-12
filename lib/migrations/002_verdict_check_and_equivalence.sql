-- wicked-ledger migration 002: verdict CHECK constraint + equivalence provenance
-- Applied automatically by DomainStore (lib/migrate.mjs) in numeric order,
-- inside its own transaction. Pure DDL — do NOT write into schema_migrations
-- here; the runner records the version row after exec() succeeds.
--
-- Two changes, both additive / backward-compatible:
--
--   1. Add a CHECK constraint to verdicts.verdict so an out-of-enum value
--      fails loudly at write time instead of silently landing a row that the
--      public manifest (schemas/evidence.json + manifest.validateShape) would
--      later reject. The enum matches the manifest verdict enum exactly,
--      INCLUDING `CONDITIONAL` (added in this release — four Tier-2 agents
--      already emit it). SQLite cannot ALTER TABLE ADD CONSTRAINT, so this is
--      the documented 12-step table redefinition: build the new table, copy
--      rows, drop the old, rename. Nothing references verdicts (the FK points
--      FROM verdicts TO runs), so no child rows are orphaned by the rename.
--
--   2. Add a nullable equivalence_json column to carry the optional
--      verdict.equivalence facet (baseline-match provenance) alongside the
--      canonical JSON. Nullable + defaulted NULL ⇒ every existing row is valid
--      and every existing reader is unaffected.
--
-- Backward compatibility: existing rows are copied verbatim. If a pre-existing
-- row somehow holds a value outside the enum, the INSERT...SELECT below would
-- fail the CHECK and abort the whole migration transaction (loud, safe, no
-- partial state). The current shipped enum values (PASS/FAIL/PARTIAL/
-- INCONCLUSIVE/N-A/SKIP) plus CONDITIONAL are all permitted, so a conformant
-- v1 ledger migrates cleanly.

-- Build the replacement table with the CHECK constraint. Column order and
-- types match 001_initial.sql exactly, plus the new equivalence_json column.
CREATE TABLE verdicts_new (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  verdict         TEXT NOT NULL CHECK (verdict IN (
                    'PASS', 'FAIL', 'PARTIAL', 'CONDITIONAL', 'INCONCLUSIVE', 'N-A', 'SKIP'
                  )),
  evidence_path   TEXT,
  reviewer        TEXT NOT NULL,
  reason          TEXT,
  equivalence_json TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);

-- Copy every existing row. equivalence_json defaults to NULL for pre-existing
-- rows (the column didn't exist before this migration).
INSERT INTO verdicts_new (id, run_id, verdict, evidence_path, reviewer, reason, created_at, updated_at, deleted, deleted_at)
SELECT id, run_id, verdict, evidence_path, reviewer, reason, created_at, updated_at, deleted, deleted_at
FROM verdicts;

DROP TABLE verdicts;

ALTER TABLE verdicts_new RENAME TO verdicts;

-- Recreate the indexes that lived on the old table (they were dropped with it).
CREATE INDEX IF NOT EXISTS idx_verdicts_run ON verdicts(run_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_verdict ON verdicts(verdict);
CREATE INDEX IF NOT EXISTS idx_verdicts_created_at ON verdicts(created_at);
