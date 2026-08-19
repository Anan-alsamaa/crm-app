import { describe, it, expect } from 'vitest';
import {
  CouponRequestDraftChecked,
  compensationFlag,
  couponWindow,
  defaultCouponDates,
  generateCouponCode,
  parseDeliveryTypes,
  toggleDeliveryType,
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

/**
 * A coupon can be valid on several fulfilment channels at once, and "All" is
 * shorthand for every one of them — so the two can never hold at the same time.
 * The column stays a comma-joined string, which is why parsing lives in one
 * place rather than in each reader.
 */
describe('delivery types', () => {
  const OFFERED = ['All', 'Delivery', 'Pickup', 'Carhop', 'Takeout', 'Dine-in'];

  it('reads a stored value, and treats an empty one as nothing selected', () => {
    expect(parseDeliveryTypes('Delivery, Takeout')).toEqual(['Delivery', 'Takeout']);
    // Older rows hold a single value — still a valid selection of one.
    expect(parseDeliveryTypes('Delivery')).toEqual(['Delivery']);
    expect(parseDeliveryTypes('')).toEqual([]);
    expect(parseDeliveryTypes(null)).toEqual([]);
    // Ragged spacing is the human's, not a second value.
    expect(parseDeliveryTypes(' Delivery ,, Pickup ')).toEqual(['Delivery', 'Pickup']);
  });

  it('adds and removes a channel', () => {
    expect(toggleDeliveryType('', 'Delivery', OFFERED)).toBe('Delivery');
    expect(toggleDeliveryType('Delivery', 'Takeout', OFFERED)).toBe('Delivery, Takeout');
    expect(toggleDeliveryType('Delivery, Takeout', 'Delivery', OFFERED)).toBe('Takeout');
    expect(toggleDeliveryType('Delivery', 'Delivery', OFFERED)).toBe('');
  });

  it('keeps "All" mutually exclusive with the specific channels, in both directions', () => {
    // Picking All clears the specifics it already covers…
    expect(toggleDeliveryType('Delivery, Pickup', 'All', OFFERED)).toBe('All');
    // …and picking a specific one drops All, which would otherwise say both
    // "every channel" and "this one channel" at once.
    expect(toggleDeliveryType('All', 'Pickup', OFFERED)).toBe('Pickup');
  });

  it('stores in the offered order, so the same selection is always the same string', () => {
    // Ticked back-to-front, stored front-to-back: two agents choosing the same
    // channels must not produce two different rows.
    expect(toggleDeliveryType('Dine-in', 'Delivery', OFFERED)).toBe('Delivery, Dine-in');
    expect(toggleDeliveryType('Takeout, Delivery', 'Pickup', OFFERED)).toBe(
      'Delivery, Pickup, Takeout',
    );
  });

  it('keeps a value the list no longer offers rather than dropping it silently', () => {
    // A retired channel on an old coupon is history, not a mistake to erase.
    expect(toggleDeliveryType('Retired', 'Delivery', OFFERED)).toBe('Delivery, Retired');
  });
});
