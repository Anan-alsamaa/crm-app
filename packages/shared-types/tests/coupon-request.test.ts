import { describe, it, expect } from 'vitest';
import {
  CouponRequestDraftChecked,
  compensationFlag,
  couponWindow,
  defaultCouponDates,
  generateCouponCode,
} from '../src/coupon-request.js';

const draft = {
  title: '+966501234567',
  code: 'SARA-ABCD2345',
  issuing_side: 'Operations',
  delivery_type: 'Delivery',
  coupon_type: 'Private',
  discount_category: 'Amount',
  valid_from: '2026-08-17',
  valid_to: '2026-09-17',
  max_discount: 50,
  usage_limit: 1,
  compensation_reason: 'Order arrived cold.',
  brand_id: 'b1',
  restaurant_id: 'r1',
};

describe('generateCouponCode', () => {
  it('leaves out the characters people misread aloud', () => {
    // A compensation code gets read down a phone line more often than typed,
    // and I/O/0/1 are where that goes wrong.
    const codes = Array.from({ length: 200 }, () => generateCouponCode());
    for (const c of codes) {
      expect(c.startsWith('SARA-')).toBe(true);
      expect(c.slice(5)).not.toMatch(/[IO01]/);
    }
  });

  it('is deterministic given a deterministic source, so a collision can be tested', () => {
    expect(generateCouponCode(() => 0)).toBe('SARA-AAAAAAAA');
  });
});

describe('couponWindow', () => {
  it('covers both end days in full', () => {
    // The owner's example: 17th to 18th is live from 17th 00:00 to 19th 00:00.
    expect(couponWindow('2026-08-17', '2026-08-18')).toEqual({
      from: '2026-08-17T00:00:00.000Z',
      to: '2026-08-19T00:00:00.000Z',
    });
  });

  it('gives a single-day coupon a whole day, not zero', () => {
    const { from, to } = couponWindow('2026-08-17', '2026-08-17');
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('crosses a month end without losing a day', () => {
    expect(couponWindow('2026-08-30', '2026-08-31').to).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('defaultCouponDates', () => {
  it('offers today plus one calendar month', () => {
    expect(defaultCouponDates(new Date('2026-08-17T09:00:00.000Z'))).toEqual({
      valid_from: '2026-08-17',
      valid_to: '2026-09-17',
    });
  });

  it('does not invent a 31st in a 30-day month', () => {
    // JS rolls 31 Sep forward to 1 Oct rather than throwing. That is the right
    // outcome here — the agent said "a month" and gets a full one — but it has
    // to be a decision rather than a surprise.
    expect(defaultCouponDates(new Date('2026-08-31T00:00:00.000Z')).valid_to).toBe('2026-10-01');
  });
});

describe('CouponRequestDraft', () => {
  it('accepts a filled-in request', () => {
    expect(CouponRequestDraftChecked.safeParse(draft).success).toBe(true);
  });

  it('refuses an end date before the start date', () => {
    const r = CouponRequestDraftChecked.safeParse({ ...draft, valid_to: '2026-08-16' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['valid_to']);
  });

  it('refuses a usage limit of zero — a coupon nobody can redeem is not a coupon', () => {
    expect(CouponRequestDraftChecked.safeParse({ ...draft, usage_limit: 0 }).success).toBe(false);
  });

  it('allows a zero maximum discount but not a negative one', () => {
    expect(CouponRequestDraftChecked.safeParse({ ...draft, max_discount: 0 }).success).toBe(true);
    expect(CouponRequestDraftChecked.safeParse({ ...draft, max_discount: -1 }).success).toBe(false);
  });

  it('does not pin the dropdown values, which operations edit without a deploy', () => {
    // "Van" is not a delivery type today. It must still validate, because the
    // admin can add it on the Dropdown values page this afternoon.
    expect(CouponRequestDraftChecked.safeParse({ ...draft, delivery_type: 'Van' }).success).toBe(
      true,
    );
    // Empty is still wrong — that is an unanswered question, not a new option.
    expect(CouponRequestDraftChecked.safeParse({ ...draft, delivery_type: '' }).success).toBe(
      false,
    );
  });

  it('lets the branch be unresolved rather than blocking the request', () => {
    // A complaint raised with no order behind it still deserves a coupon.
    const r = CouponRequestDraftChecked.safeParse({
      ...draft,
      brand_id: null,
      restaurant_id: null,
    });
    expect(r.success).toBe(true);
  });
});

describe('compensationFlag', () => {
  it('follows the checkbox, so the two can never disagree', () => {
    expect(compensationFlag(true)).toBe('Compensated');
    expect(compensationFlag(false)).toBe('Not Compensated');
  });
});
