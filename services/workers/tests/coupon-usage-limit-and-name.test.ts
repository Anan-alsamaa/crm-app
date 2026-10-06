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

describe("the coupon's name on Yiji", () => {
  /*
   * OPERATIONS' OWN CONVENTION (owner, 2026-10-05): Title = the customer's
   * number as `+9665XXXXXXXX`, the reason in the separate compensation field.
   * We were sending the reason as the name. This reverses 2026-10-03, which
   * took the phone out — see `customerFacingCouponName` for why that no longer
   * holds: the number is always the RECEIVING customer's own.
   */
  it.each(['0501234567', '+966501234567', '966501234567', '050-123-4567'])(
    'names the coupon after %s in +966 form',
    (phone) => {
      expect(customerFacingCouponName(phone, 'anything')).toBe('+966501234567');
    },
  );

  /* The number wins over a typed title: every coupon reads the same way. */
  it('prefers the number to a typed title', () => {
    expect(customerFacingCouponName('0501234567', 'Sorry for the wait')).toBe('+966501234567');
  });

  /* No number at all: a phone-shaped title is the same fact, converted. */
  it('falls back to a phone-shaped title, converted', () => {
    expect(customerFacingCouponName(null, '0501234567')).toBe('+966501234567');
  });

  /* Never blank, and never the reason. */
  it('falls back to a typed title, then a plain label', () => {
    expect(customerFacingCouponName(null, 'Sorry for the wait')).toBe('Sorry for the wait');
    expect(customerFacingCouponName('', '')).toBe('Compensation');
    expect(customerFacingCouponName(null, undefined)).toBe('Compensation');
  });

  /* In the payload: the number as the name, the reason where the console shows it. */
  it('sends the number as the name and the reason as the compensation', () => {
    expect(coupon()).toMatchObject({
      name: '+966501234567',
      compensation: 'CRM - Late delivery',
      compensationReason: 'CRM - Late delivery',
    });
  });

  /* Named after whoever RECEIVES it: on staging the test handset, never the
     real customer whose coupon was redirected away from them. */
  it('follows the staging redirect, so name and recipient agree', () => {
    const body = yijiCouponPayload(row(), null, { redirectCouponsTo: '0559999999' }) as {
      couponUser: { couponName: string; customerPhone: string; coupon: { name: string } };
    };
    expect(body.couponUser.customerPhone).toBe('+966559999999');
    expect(body.couponUser.couponName).toBe('+966559999999');
    expect(body.couponUser.coupon.name).toBe('+966559999999');
  });
});
