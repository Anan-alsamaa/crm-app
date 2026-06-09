/**
 * Per-socket token-bucket rate limiter (spec §17 / FR-034 — the gateway had no
 * throttling on inbound socket events). One bucket per socket: `capacity` is the
 * burst allowance, `refillPerSec` the sustained rate. `now` is injectable so the
 * refill curve is unit-testable.
 */
export interface TokenBucket {
  /** Try to consume one token. Returns false when the bucket is empty. */
  tryRemove(now?: number): boolean;
}

export function createTokenBucket(capacity: number, refillPerSec: number): TokenBucket {
  let tokens = capacity;
  let last = Date.now();
  return {
    tryRemove(now = Date.now()): boolean {
      const elapsedSec = Math.max(0, (now - last) / 1000);
      last = now;
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
