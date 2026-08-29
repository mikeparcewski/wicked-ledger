# Changelog

The npm package version is NOT a contract unit. wicked-ledger's two contracts —
the on-disk SQLite `schema_version` and the evidence-manifest `manifest_version`
— move on their own clocks; see [docs/SCHEMA-CONTRACT.md](docs/SCHEMA-CONTRACT.md).
Each release entry states both, so a consumer can read compat at a glance.

## [0.4.0] — 2026-08-29

Contracts: `schema_version` **3** (unchanged — no new migrations),
`manifest_version` **2.0.0 → 2.1.0** (minor: optional block only — **2.0.0
bundles stay valid**, and 2.x readers gating on the major accept 2.1 manifests).

### Added
- **Evidence-manifest 2.1: optional `scenario_evidence` block + first-class
  `claim_level` enum** (TH-5, qe campaign — #7). The 8-key evidence shape shared
  by the 2026-08 studio E2E campaign bundles lands as a manifest extension:
  required trio `scenario`/`status`/`claim_level`, optional type-checked
  `ui_steps`, `screenshots`, `wire_evidence`, `db_evidence`,
  `terminal_state_proof`, `notes`, and per-leg `legs[]` claims.
- **`claim_level` enum** (`CLAIM_LEVELS`, the single source of truth):
  `certified` | `machinery-verified` | `skipped` — honest caps that previously
  lived as free text in scenario titles. Validated honest-cap invariant: the
  scenario-level claim may never be stronger than the weakest leg (certify the
  journey, not the proxy; self-capping further is allowed).
- **`validateManifest(manifest)`** exported from `wicked-ledger/manifest` and
  the package root: the non-throwing reviewer-side entry point returning
  `{ ok, violations }`. Rule: a reviewer MUST validate a bundle before grading;
  a nonconforming bundle grades `INCONCLUSIVE`, never `PASS`/`FAIL`.
  Producer-side, `buildManifest()` runs the same validation and throws.
- New public types: `ClaimLevel`, `ScenarioEvidence`, `ScenarioEvidenceLeg`,
  `ManifestViolation`.
- Backward-compat test: a 2.0.0 bundle (no `scenario_evidence`) still validates.

### Fixed
- Restored the UTF-8 em-dash in the `package.json` description (#6).

### Release-wave note
This floor moves in one coordinated wave (recon XC-4): wicked-garden's
`wicked_ledger_version` pin and wicked-crew's ledger consumer bump with this
release, and wicked-vault's twin builder/schema (`lib/manifest.mjs`,
`schemas/evidence.json` — `additionalProperties: false` rejects 2.1 until
synced) must sync in the same wave, so no v2.0/v2.1 validator split exists.

## [0.3.0] — 2026-08-25

Contracts: `schema_version` **3**, `manifest_version` **2.0.0** (both unchanged).

### Added
- **`WICKED_RUNTIME` profile seam** (#4, #5): `resolveRuntimeProfile()` — the
  ledger fails loud under a `team` profile rather than silently writing a
  local store (no shared-store driver yet).

## [0.2.0] — 2026-08-12

Contracts: `schema_version` **3** (unchanged), `manifest_version`
**1.1.0 → 2.0.0** (major: required-field rename).

### Changed
- **Phase 6c qe rebrand** (#3): bus events stamp `domain: "qe"` and payload key
  `qe_version`; the store root is `.wicked-qe/` with dual-read of legacy
  `.wicked-testing/`; manifest 2.0.0 renames
  `environment.wicked_testing_version` → `environment.qe_version` (1.x
  manifests on disk keep the old key — consumers gate on `manifest_version`).

### Added
- Hand-authored TypeScript declarations for the public API (#2 — first tagged
  `v0.1.1`, which never reached npm; first published here).

## [0.1.0] — 2026-08-11

Contracts: `schema_version` **3** (migrations 001–003), `manifest_version` **1.1.0**.

### Added
- Initial extraction of the evidence-ledger modules from the retired
  wicked-testing package (#1): `DomainStore` CRUD over the 7-table SQLite
  schema, fixed-SQL oracle queries, `buildManifest`, additive migrations,
  fire-and-forget wicked-bus emission.
