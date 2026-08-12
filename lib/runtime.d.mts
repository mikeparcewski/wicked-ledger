/**
 * Type declarations for lib/runtime.mjs — WICKED_RUNTIME profile resolution
 * (the foundation team-profile seam).
 */

/** A recognized runtime profile name. */
export type RuntimeProfileName = "local" | "team";

/** The resolved runtime profile. */
export interface RuntimeProfile {
  /** "local" (default) or "team". */
  runtime: RuntimeProfileName;
  /** WICKED_STORE_URL verbatim, when set (meaningful under "team"). */
  storeUrl?: string | undefined;
}

/**
 * Parse WICKED_RUNTIME / WICKED_STORE_URL from `env` (default: process.env).
 * Unset / empty WICKED_RUNTIME resolves to "local". Any unrecognized value
 * throws `Error` with `code === "ERR_WICKED_RUNTIME_INVALID"`.
 */
export function resolveRuntimeProfile(env?: Record<string, string | undefined>): RuntimeProfile;

/**
 * Resolve the runtime profile and fail loudly when it names a mode this
 * package cannot honor. "team" throws `Error` with
 * `code === "ERR_WICKED_RUNTIME_TEAM_UNSUPPORTED"` — wicked-ledger has no
 * shared-store driver yet (the follow-up is a driver behind
 * `createDomainStore()`; see docs/runtime-profile.md).
 */
export function assertRuntimeSupported(env?: Record<string, string | undefined>): RuntimeProfile;
