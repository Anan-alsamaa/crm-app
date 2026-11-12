import { describe, expect, it } from 'vitest';
import {
  couponNumber,
  couponTermsChanges,
  couponTermsOf,
  couponTermsVersion,
  editedCouponTerms,
} from '../src/coupon-terms.js';

/**
 * One cleaned reading of a coupon for the edit form AND the worker (owner,
 * 2026-11-12: a reliable fix for the edit form). The rows below are the five
 * shapes found among prod's 69 delivered coupons on 2026-11-12 (phones
 * replaced): coupon_value a number, the other amounts TEXT, and older
 * Private coupons with NO total limit stored.
 */
const future = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const base = {
  status: 'assigned',
  coupon_code: 'OPS-AAAA1111',
  coupon_value: 38,
  coupon_percent: null,
  max_discount: '38.00000',
  usage_limit: 1,
  total_discount_limit: '38.00000',
  valid_from: future(0),
  valid_to: future(30),
  title: '0500000001',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  item_name: 'Chicken Truffle Risotto',
  item_sku: '44877',
  no_other_discounts: false,
  reason: 'Wrong item',
};
const SHAPES = [
  base,
  {
    ...base,
    coupon_value: 10,
    max_discount: '10.00000',
    total_discount_limit: '10.00000',
    item_name: null,
    item_sku: null,
  },
  {
    ...base,
    coupon_value: 3,
    max_discount: '3.00000',
    total_discount_limit: '3.00000',
    no_other_discounts: true,
  },
  {
    ...base,
    coupon_value: 23,
    max_discount: '23.00000',
    total_discount_limit: null,
    item_name: null,
  },
  { ...base, coupon_value: 2, max_discount: '2.00000', total_discount_limit: null },
];

describe('couponTermsOf - a stored row, cleaned', () => {
  it('reads text amounts as numbers and dates as days', () => {
    const t = couponTermsOf({ ...base, valid_to: `${future(30)}T00:00:00` });
    expect(t).toMatchObject({
      coupon_value: 38,
      max_discount: 38,
      total_discount_limit: 38,
      usage_limit: 1,
    });
    expect(t.valid_to).toBe(future(30));
  });

  it('an older Private coupon without a stored limit gets uses x maximum discount', () => {
    expect(couponTermsOf(SHAPES[3]!).total_discount_limit).toBe(23);
  });

  it('a General coupon without a typed limit has none (never invented)', () => {
    expect(
      couponTermsOf({ ...base, coupon_type: 'General', total_discount_limit: null })
        .total_discount_limit,
    ).toBeNull();
  });

  it('a percentage keeps its own ceiling and drops any amount', () => {
    const t = couponTermsOf({
      ...base,
      discount_category: 'Percentage',
      coupon_value: 9,
      coupon_percent: '15.00000',
      max_discount: '20.00000',
      total_discount_limit: '20.00000',
    });
    expect(t).toMatchObject({ coupon_value: null, coupon_percent: 15, max_discount: 20 });
  });
});

describe('an unchanged save is NOT a change, for every prod shape', () => {
  for (const [i, row] of SHAPES.entries()) {
    it(`shape ${i + 1}`, () => {
      // What the form hands back after opening and saving untouched: numbers.
      const formTerms = couponTermsOf(row);
      expect(couponTermsChanges(row, formTerms as never)).toEqual([]);
      expect(couponTermsVersion(row)).toBe(couponTermsVersion(formTerms as never));
      expect(couponTermsChanges(row, editedCouponTerms(row, formTerms) as never)).toEqual([]);
    });
  }
  it('text vs number, "" vs null, a time on a date: all the same', () => {
    expect(
      couponTermsChanges(base, {
        ...base,
        coupon_value: '38',
        item_name: 'Chicken Truffle Risotto ',
        valid_from: `${base.valid_from}T00:00:00`,
      }),
    ).toEqual([]);
    expect(couponTermsChanges({ ...base, item_sku: '' }, { ...base, item_sku: null })).toEqual([]);
  });
});

describe('a real change is seen, and the limit follows it', () => {
  it('a new value changes value, ceiling and (Private) total limit', () => {
    const edited = editedCouponTerms(base, couponTermsOf({ ...base, coupon_value: 40 }));
    expect(edited).toMatchObject({ coupon_value: 40, max_discount: 40, total_discount_limit: 40 });
    expect(couponTermsChanges(base, edited as never)).toEqual([
      'coupon_value',
      'max_discount',
      'total_discount_limit',
    ]);
  });

  it("only the dates changed: an approving admin's own total limit survives", () => {
    const row = { ...base, total_discount_limit: '76.00000' };
    const edited = editedCouponTerms(row, couponTermsOf({ ...row, valid_to: future(40) }));
    expect(edited.total_discount_limit).toBe(76);
    expect(couponTermsChanges(row, edited as never)).toEqual(['valid_to']);
  });

  it('the version moves when the terms move', () => {
    expect(couponTermsVersion(base)).not.toBe(couponTermsVersion({ ...base, coupon_value: 39 }));
  });
});

describe('couponNumber', () => {
  it('text, numbers and blanks', () => {
    expect(couponNumber('3.00000')).toBe(3);
    expect(couponNumber(2.5)).toBe(2.5);
    expect(couponNumber('')).toBeNull();
    expect(couponNumber(null)).toBeNull();
    expect(couponNumber('abc')).toBeNull();
  });
});
