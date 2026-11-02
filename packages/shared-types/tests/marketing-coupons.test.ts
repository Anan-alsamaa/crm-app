import { describe, expect, it } from 'vitest';
import {
  marketingCouponPayload,
  marketingCouponProblems,
  newMarketingCouponCode,
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
