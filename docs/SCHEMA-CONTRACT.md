# wicked-ledger — Schema-as-contract

wicked-ledger owns **two** versioned contracts, each moving on its own clock,
both decoupled from the npm package version:

1. the **on-disk SQLite schema** (`schema_version`, the `schema_migrations`
   table) — this document's first half;
2. the **evidence-manifest format** (`manifest_version`, the semver stamped
   into every `manifest.json`) — see
   [The evidence-manifest contract](#the-evidence-manifest-contract) below.

The on-disk SQLite schema is a **stability contract that is decoupled from the
npm package version.** A `wicked-ledger@0.1.0` writer and a
`wicked-ledger@0.4.x` reader can share the same ledger file as long as they
agree on the *schema* version — which moves on its own clock, defined entirely
by the ordered migration files, not by `package.json`.

## Where the schema lives

The schema is defined by the ordered files under [`lib/migrations/`](../lib/migrations):

| File | schema_version | Change |
|---|---|---|
| `001_initial.sql` | **1** | Initial 7-table schema: `projects`, `strategies`, `scenarios`, `runs`, `verdicts`, `tasks`, plus the `schema_migrations` bookkeeping table. |
| `002_verdict_check_and_equivalence.sql` | **2** | Adds a `CHECK` constraint on `verdicts.verdict` (the verdict enum) and a nullable `verdicts.equivalence_json` column (baseline-match provenance). Additive. |
| `003_vault_evidence_sha.sql` | **3** | Adds a nullable `verdicts.vault_payload_sha` column (loose, content-addressed reference to a wicked-vault payload). Additive. |

**Current `schema_version`: `3`.**

## The version mechanism (do not invent a new one)

`schema_version` is tracked by a **`schema_migrations` table** — *not* the SQLite
`user_version` pragma. `lib/migrate.mjs` (`applyMigrations`) is the single
authority:

```
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  description TEXT NOT NULL
);
```

- The runner self-creates that table, then applies every `migrations/NNN_*.sql`
  whose `version` is not already present, each inside its own transaction, in
  numeric (== lexicographic) order.
- After a file's DDL succeeds it records the row (`INSERT OR IGNORE`), so the
  version is marked applied exactly once.
- The **effective schema version is `MAX(version)` from `schema_migrations`** —
  surfaced by `DomainStore.schemaVersion()` and by the `schema_version` /
  `row_counts` oracle queries.
- `lib/domain-store.mjs` also carries a `SCHEMA_VERSION` constant (currently
  `3`) that MUST equal the highest migration on disk. It powers a
  **forward-compat lockout**: a store refuses to open a ledger whose recorded
  version is *greater* than the code's `SCHEMA_VERSION` (a newer writer wrote it;
  this older code must not touch it).

## Additive-only rule

Migrations are **additive-only.** New columns are nullable (or defaulted), new
tables/indexes are `IF NOT EXISTS`, and existing columns are never dropped or
retyped. (The `002` verdict `CHECK` uses SQLite's documented table-rebuild, but
it preserves every column and copies every row verbatim — no existing reader
loses a field.)

Consequence: **a newer writer never breaks an older reader.** Rows and columns a
reader doesn't know about are simply ignored. The only hard stop is the writer
lockout above — readers are never locked out by a *newer* schema, only writers.

## Min reader schema floor

Because the schema is additive, a reader declares the **minimum** version it
needs — the highest migration whose columns it actually reads — and tolerates
anything at or above it:

| Reader needs… | Min `schema_version` floor |
|---|---|
| verdict / run / scenario / project / task rows (core CRUD, most gate readers) | **1** |
| baseline-match provenance (`verdicts.equivalence_json`) | **2** |
| vault payload reference (`verdicts.vault_payload_sha`) | **3** |

A crew **gate reader** should assert `store.schemaVersion() >= <its floor>` and
otherwise degrade gracefully; it must NOT assert equality, or it will reject a
perfectly readable ledger that a newer garden writer has migrated forward. A
garden **writer** always writes at the current schema version (`3`) and relies
on the additive rule to keep older-floor readers working.

## The evidence-manifest contract

The second contract wicked-ledger owns: the shape of
`<ledger-root>/evidence/<run-id>/manifest.json`, versioned by the
**`manifest_version`** semver that `lib/manifest.mjs` stamps into every
manifest (`MANIFEST_VERSION`). Like `schema_version`, it moves on its own
clock — never on `package.json`'s.

### Versioning rules

- **Major** bump — a REQUIRED field is added, renamed, or retyped (a 1.x
  reader would misread a 2.x manifest). Example: 2.0.0 renamed
  `environment.wicked_testing_version` → `environment.qe_version`.
- **Minor** bump — an OPTIONAL field is added. Existing manifests stay valid;
  older readers ignore the new key.
- **Consumers gate on the major**: a 2.x reader accepts every 2.y manifest
  (`y >= 0`) and asserts `major(manifest_version) == 2`, never full equality —
  the same "assert a floor, never `==`" doctrine as the SQLite contract.

### Version history

| manifest_version | Change |
|---|---|
| `1.0.0` | Initial shape (inherited from the retired wicked-testing package). |
| `1.1.0` | Optional `verdict.equivalence` facet (baseline-match provenance). Minor. |
| `2.0.0` | `environment.wicked_testing_version` → `environment.qe_version` (Phase 6c retirement) — required-field rename, major. |
| `2.1.0` | Optional `scenario_evidence` block + first-class `claim_level` enum (TH-5, qe campaign). Minor — **2.0.0 bundles stay valid.** |

**Current `manifest_version`: `2.1.0`.**

### 2.1: `scenario_evidence` + `claim_level`

The evidence shape shared by all 21 scenario bundles of the 2026-08 studio E2E
campaign, landed as an **optional** manifest block:

- Required trio: `scenario` (string), `status` (the EXECUTOR'S CLAIM, in the
  verdict taxonomy — never the verdict of record; the manifest's top-level
  `verdict` block remains that), `claim_level`.
- Optional, type-checked: `ui_steps` (string[]), `screenshots` (string[]),
  `wire_evidence` / `db_evidence` (object or string), `terminal_state_proof`
  (string), `notes` (string or string[]), `legs` (per-leg claims:
  `{leg, claim_level, reason?}`).
- **`claim_level` enum** (`CLAIM_LEVELS` in `lib/manifest.mjs` — the single
  source of truth): `certified` (the user journey itself was exercised and
  verified) | `machinery-verified` (a disclosed proxy — e.g. an
  API-substituted step — verified the machinery, not the journey) | `skipped`
  (the leg was not executed; disclosed). Before 2.1 these caps lived as free
  text in scenario titles ("[acceptance = MACHINERY-VERIFIED]").
- **Honest-cap invariant** (validated): the scenario-level `claim_level` may
  never be STRONGER than the weakest leg in `legs[]` — certify the journey,
  not the proxy. Self-capping further is allowed.
- Campaign *plans* (wicked-garden `schemas/campaign-recon.schema.json`) may
  only plan ceilings of `certified | machinery-verified`; `skipped` is an
  outcome-only level.

### Reviewer validates before grading

`validateManifest(manifest)` (exported from `wicked-ledger/manifest` and the
package root) is the reviewer-side entry point: non-throwing, returns
`{ ok, violations: [{field, message}] }`.

**Rule: a reviewer/grader MUST validate a bundle against this contract BEFORE
grading it. A bundle that fails validation grades `INCONCLUSIVE` — never
`PASS` or `FAIL`.** Deny-dominates acceptance gates already treat
`INCONCLUSIVE` as not-satisfied, so a nonconforming bundle can never satisfy a
gate. Producer-side, `buildManifest()` runs the same validation and throws, so
a nonconforming manifest is never written by this library in the first place.

### Twin-module sync (release coordination)

wicked-vault carries a twin of the builder (`wicked-vault/lib/manifest.mjs`,
"kept in lockstep") and the normative JSON Schema
(`wicked-vault/schemas/evidence.json`, which declares
`additionalProperties: false` — a 2.1 manifest with `scenario_evidence` fails
that schema until it is synced). The twin sync and all consumer floor bumps
move in the ledger's **release wave** (one wave, never a v2.0/v2.1 validator
split mid-program); this repo's authoring change is deliberately inert until
that release.

## Summary

- **Contract units:** `schema_version` (the `schema_migrations` table) for the
  SQLite store, `manifest_version` (semver in `lib/manifest.mjs`) for the
  evidence manifest — neither is the npm package version.
- **Current values:** `schema_version` `3`; `manifest_version` `2.1.0`.
- **Direction:** additive-only, forward-only. Newer writer + older reader = OK.
- **Reader agreement:** SQLite readers assert `schemaVersion() >= floor`;
  manifest readers assert the major, never full equality.
- **Grading rule:** validate before grading; schema-fail = `INCONCLUSIVE`.
