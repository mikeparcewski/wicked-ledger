-- wicked-testing migration 003: vault_payload_sha on verdicts
-- Applied automatically by DomainStore (lib/migrate.mjs) in numeric order,
-- inside its own transaction. Pure DDL — do NOT write into schema_migrations
-- here; the runner records the version row after exec() succeeds.
--
-- Wires verdict records to vault's content-addressed payload store.
-- When wicked-vault record() is called alongside a wicked-testing verdict,
-- the resulting payload_sha256 from the vault is stored here so downstream
-- consumers can verify the artifact without re-reading the evidence directory.
--
-- Additive / backward-compatible: nullable column, default NULL. Every
-- existing verdict row is valid (vault_payload_sha stays NULL for verdicts
-- that predate the absorption or that were created without vault evidence).
--
-- Wire-up: DomainStore.create("verdicts", { ..., vault_payload_sha: sha })
-- causes domainEventToBusEvent to emit wicked.evidence.captured (see
-- lib/bus-emit.mjs for the mapping).

ALTER TABLE verdicts ADD COLUMN vault_payload_sha TEXT;

CREATE INDEX IF NOT EXISTS idx_verdicts_vault_sha ON verdicts(vault_payload_sha)
  WHERE vault_payload_sha IS NOT NULL;
