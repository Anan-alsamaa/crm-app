import { describe, it, expect } from 'vitest';
import { yijiCouponPayload, customerFacingCouponName } from '../src/processors/coupon-push.js';

/**
 * TWO FAULTS THAT MADE REAL COUPONS UNUSABLE.
 *
 * Reported by the owner via the Yiji team (2026-10-03): customers could not
 * redeem coupons issued from the CRM, and Yiji said they were "getting issued
 * for other customers". The screenshots showed a wallet listing coupons named
 * `(0596190599)`, `(0550640444)`, `(0564118118)` and a checkout refusing with
 * **"Coupon exceeds usage limit"**.
 *
 * Neither was an addressing fault. Checked against live production and the live
 * Yiji API first: the phone lookup resolved correctly 4/4, the order resolved
 * correctly 6/6, all 102 coupon codes were distinct, and no row carried
 * conflicting phones. The addressing was fine; the coupons were not.
 */

const row = (over: Record<string, unknown> = {}) =>
  ({
    coupon_code: 'OPS-ABC123',
    title: '0501234567',
    reason: 'Late delivery',
    coupon_value: 25,
    coupon_percent: null,
    max_discount: 0,
    discount_category: 'Amount',
    coupon_type: 'Private',
    delivery_type: 'All',
    usage_limit: 1,
    valid_from: '2026-10-03',
    valid_to: '2026-11-03',
    no_other_discounts: false,
    contact: { id: 'c1', name: null, phone: '0501234567', external_customer_id: 'yiji-1' },
    ...over,
  }) as never;

const coupon = (over: Record<string, unknown> = {}) =>
  (yijiCouponPayload(row(over), null) as { couponUser: { coupon: Record<string, unknown> } })
    .couponUser.coupon;

describe('how many times a coupon may be used', () => {
  /*
   * THE FAULT THAT BROKE REDEMPTION, and what settled it.
   *
   * Yiji's OWN console payload for a working coupon (captured by the owner,
   * 2026-10-03):
   *
   *     reachLimit:        1002      <- a POOL, deliberately far above
   *     monthlyReachLimit: 3         <- what one customer may use
   *     limitForUser:      (absent)  <- not a field they send at all
   *
   * `reachLimit` is the TOTAL across every holder. We were sending 1, so the
   * pool was exhausted by the first grant and the customer was refused with
   * "Coupon exceeds usage limit". All 102 coupons on production carried it.
   */
  it('never caps the pool at the per-customer figure', () => {
    const c = coupon({ usage_limit: 1 });
    expect(c.reachLimit).not.toBe(1);
    expect(Number(c.reachLimit)).toBeGreaterThanOrEqual(1000);
  });

  /* The CRM's "Number of uses" box is what ONE customer may redeem — its own
     hint says "How many times it may be redeemed". `monthlyReachLimit` is the
     field Yiji's console uses for exactly that. */
  it('carries the Number of uses as the per-customer allowance', () => {
    expect(coupon({ usage_limit: 1 })).toMatchObject({ monthlyReachLimit: 1, limitForUser: 1 });
    expect(coupon({ usage_limit: 3 })).toMatchObject({ monthlyReachLimit: 3, limitForUser: 3 });
  });

  /* The pool scales with the allowance, so it can never bind first — a pool
     that runs out before the allowance is a bug, never a policy. */
  it('keeps the pool far above the allowance', () => {
    const c = coupon({ usage_limit: 3 });
    expect(Number(c.reachLimit)).toBeGreaterThan(Number(c.monthlyReachLimit) * 10);
  });

  /* One grant is the default a compensation implies when nobody said otherwise. */
  it('defaults to one use when the field is empty', () => {
    expect(coupon({ usage_limit: null })).toMatchObject({ monthlyReachLimit: 1 });
  });
});

describe('the name the customer reads in their wallet', () => {
  /*
   * THE PRIVACY LEAK. `title` is pre-filled with the customer's phone — a
   * useful handle inside the CRM, where an agent scans a list of
   * compensations. Yiji prints the coupon's NAME in the wallet, so that number
   * was being shown to whoever held the coupon.
   */
  it.each(['0501234567', '+966501234567', '966 50 123 4567', '050-123-4567'])(
    'never sends %s as the name',
    (phone) => {
      expect(customerFacingCouponName(phone, 'Late delivery')).toBe('Late delivery');
    },
  );

  /* A title an agent actually typed is theirs — they wrote it to be read. */
  it('keeps a real title', () => {
    expect(customerFacingCouponName('Sorry for the wait', 'Late delivery')).toBe(
      'Sorry for the wait',
    );
  });

  /* A name with letters in it is a name, however many digits it also has. */
  it('keeps a title that merely contains numbers', () => {
    expect(customerFacingCouponName('Order 1328524 compensation', 'x')).toBe(
      'Order 1328524 compensation',
    );
  });

  /* Never blank: an unnamed coupon in a wallet is worse than a plain one. */
  it('falls back to a plain label when there is no reason either', () => {
    expect(customerFacingCouponName('0501234567', null)).toBe('Compensation');
    expect(customerFacingCouponName('', '')).toBe('Compensation');
    expect(customerFacingCouponName(null, undefined)).toBe('Compensation');
  });

  /* A short number is a label, not a phone — "25" or "2024" must survive. */
  it('does not mistake a short number for a phone', () => {
    expect(customerFacingCouponName('25', 'Late delivery')).toBe('25');
  });

  /* And it reaches the payload, not just the helper. */
  it('is what the coupon actually carries', () => {
    expect(coupon()).toMatchObject({ name: 'Late delivery' });
  });
});
