/**
 * THE ONE GATE EVERY OUTBOUND YIJI CALL PASSES (2026-10-26 incident).
 *
 * The interface and the process-wide slot only - no imports, so the Yiji
 * client (`yiji-impl.ts`) can consult it without an import cycle, and a browser
 * bundle that never installs a guard pays nothing: with the slot empty every
 * call goes out exactly as before. The implementation (budget, priorities,
 * circuit breaker) is `yiji-guard.ts`; each service installs one at start.
 *
 * Kept on `globalThis` under a registry symbol rather than a module variable:
 * in a pnpm workspace one package can be instantiated twice, and a guard
 * installed into one copy must still be the guard the other copy's client sees.
 */

/** How one call to Yiji went, as far as the guard cares. */
export interface YijiGuardOutcome {
  /** Null when no response arrived (timeout, network error). */
  status: number | null;
  /** The response's `Retry-After` header, verbatim, when it had one. */
  retryAfter?: string | null;
}

export interface YijiOutboundGuard {
  /**
   * Resolves when a call for `operation` may be sent now (possibly after a
   * short wait); REJECTS with a `YijiUnavailableError` (a `YijiShedError`)
   * when it may not. Never sends anything itself.
   */
  admit(operation: string): Promise<void>;
  /** Told how an admitted call went. Must never throw. */
  observe(operation: string, outcome: YijiGuardOutcome): void;
}

const SLOT = Symbol.for('yiji.crm.outboundGuard');
type Slot = { [SLOT]?: YijiOutboundGuard | null };

/** Install (or with null, remove) this process's guard. */
export function setYijiOutboundGuard(guard: YijiOutboundGuard | null): void {
  (globalThis as Slot)[SLOT] = guard;
}

/** This process's guard, or null when none is installed (browser, tests). */
export function currentYijiOutboundGuard(): YijiOutboundGuard | null {
  return (globalThis as Slot)[SLOT] ?? null;
}
