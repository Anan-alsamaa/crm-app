import { describe, expect, it } from 'vitest';
import { rowCarriesCoupon } from '../src/features/late-orders/api.js';

// Owner, 2026-10-16: a comment on order 1323407 (compensated on 29 Sep) showed
// the September coupon, so the comment looked like it had assigned one.
describe('late-orders register: only a compensated row shows the coupon', () => {
  it('compensated rows carry the order coupon', () => {
    expect(rowCarriesCoupon({ action: 'compensated' })).toBe(true);
  });
  it('comment rows never do, even when the order was compensated before', () => {
    expect(rowCarriesCoupon({ action: 'commented' })).toBe(false);
    expect(rowCarriesCoupon({ action: null })).toBe(false);
    expect(rowCarriesCoupon({})).toBe(false);
  });
});
