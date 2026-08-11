-- wicked-testing migration 001: initial 7-table schema
-- Applied automatically by DomainStore on first open.
-- To apply manually: sqlite3 .wicked-testing/wicked-testing.db < lib/migrations/001_initial.sql

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at);

CREATE TABLE IF NOT EXISTS strategies (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  name         TEXT NOT NULL,
  body         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_strategies_project ON strategies(project_id);
CREATE INDEX IF NOT EXISTS idx_strategies_created_at ON strategies(created_at);

CREATE TABLE IF NOT EXISTS scenarios (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  strategy_id    TEXT REFERENCES strategies(id),
  name           TEXT NOT NULL,
  format_version TEXT NOT NULL,
  body           TEXT,
  source_path    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_scenarios_project ON scenarios(project_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_strategy ON scenarios(strategy_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_created_at ON scenarios(created_at);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  scenario_id   TEXT NOT NULL REFERENCES scenarios(id),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,
  evidence_path TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_scenario ON runs(scenario_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);

CREATE TABLE IF NOT EXISTS verdicts (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  verdict       TEXT NOT NULL,
  evidence_path TEXT,
  reviewer      TEXT NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_verdicts_run ON verdicts(run_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_verdict ON verdicts(verdict);
CREATE INDEX IF NOT EXISTS idx_verdicts_created_at ON verdicts(created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  title           TEXT NOT NULL,
  body            TEXT,
  status          TEXT NOT NULL,
  assignee_skill  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      INTEGER PRIMARY KEY,
  applied_at   TEXT NOT NULL,
  description  TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'v1 initial 7-table schema');
