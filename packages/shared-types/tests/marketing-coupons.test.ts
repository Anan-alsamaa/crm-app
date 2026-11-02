import { describe, expect, it } from 'vitest';
import {
  marketingCouponPayload,
  marketingCouponProblems,
  newMarketingCouponCode,
  parseRecipientList,
  type MarketingCouponDraft,
} from '../src/marketing-coupons.js';

const base: MarketingCouponDraft = {
  code: 'MKT-AB12CD34',
  title: 'World Pasta Day',
  description: 'Campaign for World Pasta Day',
  discount_category: 'Amount',
  coupon_value: 20,
  valid_from: '2026-11-10',
  valid_to: '2026-11-20',
  total_uses: 500,
  uses_per_customer: 1,
};

describe('marketing coupon rules', () => {
  it('a new code is MKT- and 8 characters', () => {
    expect(newMarketingCouponCode()).toMatch(/^MKT-[A-Z0-9]{8}$/);
  });

  it('a complete amount coupon has no problems', () => {
    expect(marketingCouponProblems(base)).toEqual([]);
  });

  it('refuses what would make a wrong coupon', () => {
    expect(marketingCouponProblems({ ...base, coupon_value: 0 })).toHaveLength(1);
    expect(marketingCouponProblems({ ...base, code: 'OPS-AB12CD34' })).toHaveLength(1);
    expect(marketingCouponProblems({ ...base, valid_to: '2026-11-01' })).toHaveLength(1);
    expect(marketingCouponProblems({ ...base, uses_per_customer: 600 })).toHaveLength(1);
    expect(
      marketingCouponProblems({ ...base, discount_category: 'Percentage', coupon_percent: 20 }),
    ).toContain('A percentage coupon needs a maximum discount in SAR.');
  });
});

describe('the Yiji AddCoupon body', () => {
  it('is a General coupon held by nobody, with the marketing issuing side', () => {
    const p = marketingCouponPayload(base);
    expect(p.type).toBe(0);
    expect(p.assignee).toEqual([]);
    expect(p.issuingSideId).toBe(3);
    expect(p.code).toBe('MKT-AB12CD34');
    expect(p.discount).toBe(20);
    expect(p.discountPercentage).toBe(0);
    expect(p.reachLimit).toBe(500);
    expect(p.limitForUser).toBe(1);
  });

  it('never carries a restaurant; a brand only when chosen', () => {
    expect(marketingCouponPayload(base)).not.toHaveProperty('restaurantId');
    expect(marketingCouponPayload(base)).not.toHaveProperty('brandId');
    expect(marketingCouponPayload({ ...base, yiji_brand_id: 3 }).brandId).toBe(3);
  });

  it('a percentage coupon carries the percentage and the cap, not an amount', () => {
    const p = marketingCouponPayload({
      ...base,
      discount_category: 'Percentage',
      coupon_value: 50,
      coupon_percent: 15,
      max_discount: 30,
    });
    expect(p.category).toBe(0);
    expect(p.discount).toBe(0);
    expect(p.discountPercentage).toBe(15);
    expect(p.maximumDiscount).toBe(30);
  });
});

describe('a bulk list', () => {
  it('reads one number per line or a CSV column, in every spelling, once each', () => {
    const r = parseRecipientList(
      'name,phone\nAli,0501234567\n+966 50 123 4567\n00966551112222\n551112222\nbad,12345\n0561234567',
    );
    expect(r.phones).toEqual(['0501234567', '0551112222', '0561234567']);
    expect(r.duplicates).toBe(2);
    expect(r.invalid).toEqual(['bad,12345']);
  });

  it('a list coupon is Private on Yiji', () => {
    expect(marketingCouponPayload({ ...base, audience: 'list' }).type).toBe(1);
    expect(marketingCouponPayload(base).type).toBe(0);
  });
});

describe('what a coupon can cost at most', () => {
  it('amount x total uses; cap x uses for a percentage; list size for a bulk send', async () => {
    const { marketingCouponMaxCost } = await import('../src/marketing-coupons.js');
    expect(marketingCouponMaxCost(base)).toBe(20 * 500);
    expect(
      marketingCouponMaxCost({ ...base, discount_category: 'Percentage', max_discount: 30 }),
    ).toBe(30 * 500);
    expect(
      marketingCouponMaxCost({
        ...base,
        audience: 'list',
        recipient_count: 120,
        uses_per_customer: 2,
      }),
    ).toBe(20 * 240);
  });
});
