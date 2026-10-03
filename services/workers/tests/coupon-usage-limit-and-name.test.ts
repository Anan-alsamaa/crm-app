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
   * THE FAULT THAT BROKE REDEMPTION.
   *
   * `reachLimit` is the TOTAL across every holder, not a per-person allowance.
   * Sending 1 meant the first customer to spend theirs exhausted the coupon and
   * every other holder was refused — which is exactly the message they saw.
   * Every one of the 102 coupons on production carried it.
   */
  it('does not cap the TOTAL redemptions', () => {
    expect(coupon()).not.toHaveProperty('reachLimit');
  });

  /* The CRM's "Number of uses" box means per customer — its own hint says
     "How many times it may be redeemed". That is where its number belongs. */
  it('caps what ONE customer may redeem', () => {
    expect(coupon({ usage_limit: 1 })).toMatchObject({ limitForUser: 1 });
    expect(coupon({ usage_limit: 3 })).toMatchObject({ limitForUser: 3 });
  });

  /* Monthly is per-customer too, so it follows the same box. */
  it('tracks the same number monthly', () => {
    expect(coupon({ usage_limit: 3 })).toMatchObject({ monthlyReachLimit: 3 });
  });

  /* One grant is the default a compensation implies when nobody said otherwise. */
  it('defaults to one use when the field is empty', () => {
    expect(coupon({ usage_limit: null })).toMatchObject({ limitForUser: 1 });
  });

  /*
   * THE ONE CASE THAT DOES NEED A TOTAL CAP.
   *
   * An UNASSIGNED coupon is created without a customer and its code goes to one
   * person over WhatsApp. It is bearer-like — anybody who learns the code can
   * spend it, and `limitForUser` cannot help because every spender is a
   * different user. Capping the total is what keeps the blast radius to the
   * grant that was approved.
   */
  it('caps the TOTAL on a coupon nobody holds', () => {
    /* The unassigned payload is the coupon FLAT — `AddCoupon` takes the coupon
       itself, with no `couponUser` envelope to put it in. */
    const unassigned = yijiCouponPayload(row(), null, {
      unassigned: true,
    }) as Record<string, unknown>;
    expect(unassigned).toMatchObject({ reachLimit: 1, limitForUser: 1 });
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
