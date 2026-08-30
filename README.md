# wicked-ledger

**Infra: the wicked evidence ledger.** A verdict / run / scenario `DomainStore`
+ a fixed oracle-query library + additive SQLite migrations — the shared
persistence primitive that QE **writers** (record verdicts, runs, scenarios)
and gate **readers** (re-derive "done" from recorded evidence) both build on.

Dual-write by design: canonical JSON is the source of truth, a `better-sqlite3`
index makes it queryable, and the two are kept in agreement (JSON writes first;
the index degrades gracefully to JSON-only if the native module can't load).

<!-- historical -->
> **Provenance.** These modules were extracted from the (now retired)
> `wicked-testing` package's self-contained ledger lib (Stage 1 of the
> evidence-ledger → infra carve). Phase 6c completed the fold: the consumers
> (`wicked-crew`, `wicked-garden`'s qe skills) read and write through this
> package, and the wicked-testing name survives only in legacy on-disk
> artifacts (see the decision note below).
<!-- /historical -->

> **Decision note — on-disk root rename (Phase 6c).** The ledger root renamed
> `.wicked-testing/` → **`.wicked-qe/`** with **dual-read**: `resolveLedgerRoot`
> prefers `<base>/.wicked-qe`, falls back to an existing legacy
> `<base>/.wicked-testing` (that store keeps its root — reads AND writes — so a
> ledger never splits across two dirs), and new repos get `.wicked-qe`. The
> derived SQLite index follows the same rule (`wicked-qe.db` for new stores; an
> existing `wicked-testing.db` is reused). The evidence-manifest schema bumped <!-- historical: legacy index filename an existing store keeps (dual-read contract) -->
> to `manifest_version` **2.0.0**: `environment.wicked_testing_version` →
> `environment.qe_version` (1.x manifests on disk keep the old key — consumers
> gate on `manifest_version`). Bus events now stamp `domain: "qe"` and payload
> key `qe_version`.

## Install

```sh
npm install wicked-ledger
```

Runtime dependency: [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)
`^13` (a native module; ships prebuilt binaries for common platforms, and the
store falls back to JSON-only if it fails to load). Requires Node `>= 20`.

## Quick start

```js
import { createDomainStore, buildOracleQuery } from "wicked-ledger";
import { createRequire } from "node:module";

const store = createDomainStore({ root: ".wicked-ledger" }); // runs migrations

// The FK chain the schema requires to land a verdict:
const project  = store.create("projects",  { name: "my-project" });
const scenario = store.create("scenarios", { project_id: project.id, name: "checkout-works", format_version: "1.0" });
const run      = store.create("runs",      { project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: "running" });
const verdict  = store.create("verdicts",  { run_id: run.id, verdict: "PASS", reviewer: "acceptance-test-reviewer" });

store.get("verdicts", verdict.id);            // → the verdict row
store.list("verdicts", { run_id: run.id });   // → [ verdict ]

// Fixed, auditable oracle queries (no LLM-generated SQL):
const { sql, params } = buildOracleQuery("last_verdict_for_scenario", { scenario_name: "checkout-works" });
// run sql/params against the ledger db with your own better-sqlite3 handle
```

## API surface

Import everything from the package root, or a single module by subpath.

| Export | From | What it does |
|---|---|---|
| `createDomainStore(opts)` / `DomainStore` | `wicked-ledger/domain-store` | Dual-write store for `projects` / `strategies` / `scenarios` / `runs` / `verdicts` / `tasks`. `create` / `get` / `list` / `update` / `delete` / `search` / `stats` / `rebuildIndex` / `schemaVersion` / `close`. Singleton per resolved root. |
| `SCHEMA_VERSION` | `wicked-ledger/domain-store` | The schema version this code targets (`3`). Must equal the highest migration. |
| `buildOracleQuery(name, filters)`, `routeQuestion(q, filters)`, `QUERIES`, `QUERY_NAMES`, `supportedPatterns()` | `wicked-ledger/oracle-queries` | 13 named, parameterized read queries + a keyword router. Every query is a plain auditable `SELECT`. |
| `buildManifest(opts)`, `validateManifest(m)`, `MANIFEST_VERSION`, `VERDICT_VALUES`, `CLAIM_LEVELS` | `wicked-ledger/manifest` | Builds the public evidence `manifest.json` for a run (manifest `2.1.0`: optional `scenario_evidence` block + `claim_level` enum); the single verdict-enum and claim-level source of truth. `validateManifest` is the reviewer-side check — validate before grading, schema-fail = `INCONCLUSIVE`. |
| `applyMigrations(db, dir)`, `listMigrations(dir)` | `wicked-ledger/migrate` | Versioned migration runner (used internally by the store; exposed for tooling / dry-runs). |
| `emitBusEvent(type, payload)`, `domainEventToBusEvent(action, source, record, version)` | `wicked-ledger/bus-emit` | Fire-and-forget `wicked-bus` emission. No-ops when the `wicked-bus` binary is absent; never throws. |

`vault_payload_sha` on a verdict is stored as a **plain string** — a loose,
content-addressed reference to a wicked-vault payload. The ledger does **not**
depend on the `wicked-vault` package; it stays independently extractable.

## Schema is a contract

The on-disk SQLite schema is a stability contract **decoupled from the npm
package version** — it moves on the clock of the ordered `lib/migrations/*.sql`
files, tracked by a `schema_migrations` table (current `schema_version`: **3**),
and is **additive-only**. A newer writer never breaks an older reader.

See **[docs/SCHEMA-CONTRACT.md](docs/SCHEMA-CONTRACT.md)** for the version
mechanism, the additive-only rule, and the "min reader schema floor" guidance
that lets a garden writer and a crew reader agree across package-version skew —
plus the second contract the ledger owns: the **evidence-manifest format**
(`manifest_version`, currently **2.1.0**) and the reviewer-validates-before-
grading rule.

## Test

```sh
npm test   # node test/smoke.mjs — migration round-trip + oracle query + manifest
```

## License

MIT © Mike Parcewski
