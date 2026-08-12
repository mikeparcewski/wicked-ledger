/**
 * Type declarations for lib/bus-emit.mjs — fire-and-forget wicked-bus
 * emission (docs/INTEGRATION.md § 4 event contract).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/bus-emit.mjs — CI runs `npm run typecheck` so drift fails loudly.
 */

/**
 * Public event types produced by domainEventToBusEvent(). (The wider
 * catalog also lists wicked.contract.published, but that is emitted by the
 * wicked-vault CLI directly and never passes through this module.)
 */
export type LedgerBusEventType =
  | "wicked.test.strategy.generated"
  | "wicked.test.scenario.authored"
  | "wicked.test.run.started"
  | "wicked.test.run.completed"
  | "wicked.test.verdict.created"
  | "wicked.test.evidence.captured";

export interface LedgerBusEvent {
  type: LedgerBusEventType;
  payload: Record<string, unknown>;
}

/** DomainStore CRUD action driving event mapping. */
export type DomainAction = "create" | "update" | "delete";

/**
 * Emit an event via the wicked-bus CLI. Fire-and-forget: silently no-ops
 * when wicked-bus is not on PATH.
 *
 * @returns true if the emit spawned cleanly; false if the bus is absent or
 *          the spawn failed. Never throws.
 */
export function emitBusEvent(type: string, payload?: Record<string, unknown>): boolean;

/**
 * Map a DomainStore CRUD event to its public event(s).
 *
 * @returns a single event, an array (verdicts.create with vault_payload_sha
 *          fires verdict.created + evidence.captured), or null when the
 *          action produces no public event.
 */
export function domainEventToBusEvent(
  action: DomainAction,
  source: string,
  record: Record<string, unknown> | null,
  wickedTestingVersion: string,
): LedgerBusEvent | LedgerBusEvent[] | null;

/**
 * Test-only hook: reset the cached bus-availability probe.
 * Do not call from app code.
 */
export function __resetBusAvailabilityForTests(): void;
