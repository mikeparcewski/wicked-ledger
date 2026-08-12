/**
 * lib/runtime.mjs — WICKED_RUNTIME profile resolution (the foundation
 * team-profile seam).
 *
 * The wicked foundation packages (wicked-estate, wicked-vault, wicked-ledger,
 * wicked-bus) flip together on one environment switch:
 *
 *   WICKED_RUNTIME=local   (default) — zero-infra local stores
 *   WICKED_RUNTIME=team    — self-hosted shared Postgres
 *                            (WICKED_STORE_URL=postgres://…)
 *
 * wicked-ledger's domain store is JSON-canonical + a better-sqlite3 index —
 * **local-only today**. There is no shared-store driver yet, so `team` fails
 * loudly here instead of silently writing engineer-local verdict state that
 * the rest of a team-profile deployment would expect to be shared. The
 * follow-up interface is a store driver behind `createDomainStore()` — the
 * same seam the dual-write JSON+SQLite store already sits behind (see
 * docs/runtime-profile.md). Until that driver exists, honesty > fake.
 */

const PROFILES = new Set(["local", "team"]);

/**
 * Parse WICKED_RUNTIME / WICKED_STORE_URL from `env` (default: process.env).
 *
 * Returns `{ runtime, storeUrl }` where runtime is "local" or "team".
 * Unset / empty WICKED_RUNTIME resolves to "local". Any other value throws
 * `ERR_WICKED_RUNTIME_INVALID` — a typo must never silently fall back to a
 * local store in a deployment that believes it is shared.
 */
export function resolveRuntimeProfile(env = process.env) {
  const raw = (env.WICKED_RUNTIME ?? "local").trim().toLowerCase() || "local";
  if (!PROFILES.has(raw)) {
    const err = new Error(
      `WICKED_RUNTIME='${raw}' is not a recognized runtime profile (expected 'local' or 'team')`,
    );
    err.code = "ERR_WICKED_RUNTIME_INVALID";
    throw err;
  }
  return { runtime: raw, storeUrl: env.WICKED_STORE_URL };
}

/**
 * Resolve the runtime profile and fail loudly when it names a mode this
 * package cannot honor. Called by `createDomainStore()` before any store I/O.
 *
 * - local → returns the profile; the JSON + better-sqlite3 store proceeds.
 * - team  → throws `ERR_WICKED_RUNTIME_TEAM_UNSUPPORTED`: wicked-ledger has
 *           no shared-store driver, and quietly using the local store under
 *           a team profile would fork verdict state per engineer.
 */
export function assertRuntimeSupported(env = process.env) {
  const profile = resolveRuntimeProfile(env);
  if (profile.runtime === "team") {
    const err = new Error(
      "WICKED_RUNTIME=team: wicked-ledger is local-only today — the domain store is " +
        "JSON + better-sqlite3 with no shared-store driver, so team mode would silently " +
        "produce engineer-local verdict state instead of the shared record the profile " +
        "promises. A Postgres store driver behind createDomainStore() is the named " +
        "follow-up (docs/runtime-profile.md). Unset WICKED_RUNTIME (or set " +
        "WICKED_RUNTIME=local) to use the local store.",
    );
    err.code = "ERR_WICKED_RUNTIME_TEAM_UNSUPPORTED";
    throw err;
  }
  return profile;
}
