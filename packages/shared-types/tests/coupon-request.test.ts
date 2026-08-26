import { describe, it, expect } from 'vitest';
import {
  CouponRequestDraftChecked,
  compensationFlag,
  couponWindow,
  defaultCouponDates,
  couponTermsProblems,
  couponExposure,
  isHighValueCoupon,
  yijiDeliveryTypes,
  COUPON_ALERT_THRESHOLD_SAR,
  generateCouponCode,
  isPercentageCategory,
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
  coupon_value: 50,
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

  it('allows a zero maximum discount on an amount but not a negative one', () => {
    // Zero means "no separate ceiling"; on an amount coupon the amount is the
    // ceiling, so there is nothing to contradict.
    expect(CouponRequestDraftChecked.safeParse({ ...draft, max_discount: 0 }).success).toBe(true);
    expect(CouponRequestDraftChecked.safeParse({ ...draft, max_discount: -1 }).success).toBe(false);
  });

  it('refuses an amount coupon with no amount — this shipped, and one was approved worth 0', () => {
    const { coupon_value: _omitted, ...noAmount } = draft;
    expect(CouponRequestDraftChecked.safeParse(noAmount).success).toBe(false);
    expect(CouponRequestDraftChecked.safeParse({ ...draft, coupon_value: 0 }).success).toBe(false);
  });

  it('refuses a cap below the amount — one of the two numbers would be a lie', () => {
    // The shape of the row that reached production: 568 off, capped at 55.
    const r = CouponRequestDraftChecked.safeParse({
      ...draft,
      coupon_value: 568,
      max_discount: 55,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['max_discount']);
  });

  it('refuses a percentage with no ceiling — an uncapped percentage is an open cheque', () => {
    const pct = {
      ...draft,
      discount_category: 'Percentage',
      coupon_value: null,
      coupon_percent: 20,
    };
    expect(CouponRequestDraftChecked.safeParse({ ...pct, max_discount: 0 }).success).toBe(false);
    expect(CouponRequestDraftChecked.safeParse({ ...pct, max_discount: 50 }).success).toBe(true);
  });

  it('refuses a percentage of zero', () => {
    const r = CouponRequestDraftChecked.safeParse({
      ...draft,
      discount_category: 'Percentage',
      coupon_value: null,
      coupon_percent: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe('couponTermsProblems', () => {
  it('names the field that owns each problem, so a form can point at it', () => {
    const problems = couponTermsProblems({
      discount_category: 'Amount',
      coupon_value: null,
      coupon_percent: null,
      max_discount: 0,
    });
    expect(problems.map((p) => p.field)).toEqual(['coupon_value']);
  });

  it('reads the category loosely, because operations edit that list', () => {
    // The stored value is whatever the option list says. "percentage",
    // "Percentage Discount" and "PERCENT" all mean the same shape of coupon,
    // and pinning the exact string here would break the day someone renames it.
    expect(isPercentageCategory('Percentage')).toBe(true);
    expect(isPercentageCategory('percentage discount')).toBe(true);
    expect(isPercentageCategory('PERCENT')).toBe(true);
    expect(isPercentageCategory('Amount')).toBe(false);
    expect(isPercentageCategory(null)).toBe(false);
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

describe('high-value coupon alert', () => {
  it('measures a flat amount as its own exposure', () => {
    expect(
      couponExposure({ discount_category: 'Amount', coupon_value: 250, max_discount: 250 }),
    ).toBe(250);
  });

  it('measures a PERCENTAGE by its cap, not its percentage', () => {
    /*
     * 20 is not 20 riyals. The cap is the only bound on what a percentage
     * actually pays out — which is why `couponTermsProblems` refuses a
     * percentage that has none.
     */
    expect(
      couponExposure({ discount_category: 'Percentage', coupon_percent: 20, max_discount: 300 }),
    ).toBe(300);
  });

  it('reads a half-filled draft as zero rather than guessing', () => {
    // Otherwise the alert fires while the agent is still typing.
    expect(
      couponExposure({ discount_category: 'Amount', coupon_value: null, max_discount: null }),
    ).toBe(0);
  });

  it('fires ABOVE the threshold, not at it', () => {
    const at = { discount_category: 'Amount', coupon_value: 200, max_discount: 200 };
    const above = { discount_category: 'Amount', coupon_value: 200.01, max_discount: 200.01 };
    expect(isHighValueCoupon(at)).toBe(false);
    expect(isHighValueCoupon(above)).toBe(true);
  });

  it('pins the threshold the Directus hook hardcodes', () => {
    /*
     * THIS TEST IS THE CONTRACT. `directus/extensions/notify-on-change/index.js`
     * re-declares COUPON_ALERT_THRESHOLD_SAR and its own `couponExposure`,
     * because extensions load in the stock Directus image with no bundler and
     * cannot import this package. That duplication is only safe while something
     * fails when the two drift — this is that something. If you change the
     * threshold here, change it there too.
     */
    expect(COUPON_ALERT_THRESHOLD_SAR).toBe(200);
  });
});

describe('yijiDeliveryTypes', () => {
  it('returns null for "All" — Yiji spells unrestricted as an ABSENT list', () => {
    /*
     * Enumerating every channel would look more explicit and be worse: it
     * breaks silently the moment Yiji adds a channel, whereas an absent list
     * keeps meaning "all of them" for ever.
     */
    expect(yijiDeliveryTypes('All')).toBeNull();
    expect(yijiDeliveryTypes('')).toBeNull();
    expect(yijiDeliveryTypes(null)).toBeNull();
  });

  it('maps a specific selection, de-duplicated', () => {
    expect(yijiDeliveryTypes('Delivery, Pickup')).toEqual([1, 2]);
    // Carhop and Drive Thru are the same service under two names.
    expect(yijiDeliveryTypes('Carhop, Drive Thru')).toEqual([3]);
  });

  it('drops the WHOLE list when any one channel is unrecognised', () => {
    /*
     * The case that matters. A partial list silently narrows the coupon to
     * fewer channels than were approved — it would work in some places and not
     * others with nothing explaining why. No restriction beats a wrong one.
     */
    expect(yijiDeliveryTypes('Delivery, Teleport')).toBeNull();
  });

  it('is case and spacing insensitive, because the list is operations-edited', () => {
    expect(yijiDeliveryTypes('  delivery ,  PICKUP ')).toEqual([1, 2]);
  });
});
