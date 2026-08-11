# wicked-ledger — Schema-as-contract

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

## Summary

- **Contract unit:** `schema_version` (the `schema_migrations` table), not the
  npm package version.
- **Current value:** `3`.
- **Direction:** additive-only, forward-only. Newer writer + older reader = OK.
- **Reader agreement:** assert `schemaVersion() >= floor`, never `==`.
