# WICKED_RUNTIME profile — wicked-ledger

The wicked foundation packages (wicked-estate, wicked-vault, wicked-ledger,
wicked-bus) flip together on one environment switch:

| Env | Meaning |
|---|---|
| `WICKED_RUNTIME=local` (or unset) | Zero-infra local stores — the default. |
| `WICKED_RUNTIME=team` | Self-hosted shared Postgres (`WICKED_STORE_URL=postgres://…`). |

Any other `WICKED_RUNTIME` value is an error (`ERR_WICKED_RUNTIME_INVALID`) —
a typo must never silently fall back to a local store in a deployment that
believes it is shared.

## wicked-ledger is local-only today

The domain store is **JSON-canonical + a better-sqlite3 index** under
`.wicked-qe/` (legacy `.wicked-testing/`). There is **no shared-store
driver**, so under `WICKED_RUNTIME=team` the package fails loudly instead of
faking it:

- `createDomainStore()` throws `ERR_WICKED_RUNTIME_TEAM_UNSUPPORTED` before
  any store I/O.
- Rationale: quietly opening the local store under a team profile would fork
  verdict/run state per engineer, while the rest of the deployment (estate on
  shared Postgres) believes the record is shared. A loud refusal is the honest
  behavior until the driver exists.

`resolveRuntimeProfile(env?)` and `assertRuntimeSupported(env?)` are exported
(root barrel and `wicked-ledger/runtime`) so consumers can resolve the profile
without triggering store I/O.

## Named follow-up: the store driver seam

The team-mode implementation is a **store driver behind `createDomainStore()`**
— the same seam the dual-write JSON+SQLite store already sits behind. A
Postgres driver must provide the `DomainStore` surface (CRUD on the six
tables, `schemaVersion()`, oracle query execution) against
`WICKED_STORE_URL`, with migrations managed server-side. Until that driver
lands, `team` is rejected here by design.
