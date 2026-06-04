import { describe, it, expect } from 'vitest';
import { createTokenBucket } from '../src/rate-limit.js';

describe('createTokenBucket', () => {
  it('allows up to capacity in a burst, then blocks', () => {
    const b = createTokenBucket(3, 1);
    const t0 = 1_000_000;
    expect(b.tryRemove(t0)).toBe(true);
    expect(b.tryRemove(t0)).toBe(true);
    expect(b.tryRemove(t0)).toBe(true);
    expect(b.tryRemove(t0)).toBe(false); // bucket empty, no time elapsed
  });

  it('refills over time at refillPerSec', () => {
    const b = createTokenBucket(2, 5); // 5 tokens/sec
    const t0 = 2_000_000;
    expect(b.tryRemove(t0)).toBe(true);
    expect(b.tryRemove(t0)).toBe(true);
    expect(b.tryRemove(t0)).toBe(false);
    // 250ms later → +1.25 tokens → one more allowed
    expect(b.tryRemove(t0 + 250)).toBe(true);
    expect(b.tryRemove(t0 + 250)).toBe(false);
  });

  it('never exceeds capacity even after a long idle', () => {
    const b = createTokenBucket(2, 100);
    const t0 = 3_000_000;
    // idle 10s would add 1000 tokens, but capacity caps at 2
    expect(b.tryRemove(t0 + 10_000)).toBe(true);
    expect(b.tryRemove(t0 + 10_000)).toBe(true);
    expect(b.tryRemove(t0 + 10_000)).toBe(false);
  });
});
