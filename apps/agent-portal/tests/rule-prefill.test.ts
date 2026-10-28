import { describe, it, expect, vi } from 'vitest';
import type { CompensationRule } from '@yiji/shared-types';
import {
  isAdjusted,
  nextRuleCoupon,
  policyFields,
  suggestionFor,
  type RuleCouponState,
} from '../src/features/coupons/rule-prefill.js';

/** Who wins in the coupon section: the agent, always, once they acted. */

const rule = (over: Partial<CompensationRule> = {}): CompensationRule => ({
  id: 'r1',
  name: 'Rule one',
  active: true,
  priority: 0,
  complaint_type: 'Late order',
  discount_category: 'Amount',
  coupon_value: 30,
  ...over,
});
const ctx = {
  today: new Date('2026-10-27T08:00:00Z'),
  phone: '0500000000',
  brandId: 'B',
  restaurantId: '9',
};
const build = (r: CompensationRule) => suggestionFor(r, { ...ctx, random: () => 0 });
const empty: RuleCouponState = {
  assignCoupon: false,
  collectedCoupon: null,
  rule: null,
  declined: false,
};

describe('nextRuleCoupon', () => {
  it('a match pre-fills: ticked, the suggestion collected, the rule remembered', () => {
    const s = nextRuleCoupon(empty, rule(), build);
    expect(s.assignCoupon).toBe(true);
    expect(s.collectedCoupon?.coupon_value).toBe(30);
    expect(s.collectedCoupon?.code).toMatch(/^CC-/);
    expect(s.rule?.id).toBe('r1');
  });

  it('no match and nothing pre-filled: unchanged (same object)', () => {
    expect(nextRuleCoupon(empty, null, build)).toBe(empty);
  });

  it('the same rule again: kept as is (no new code)', () => {
    const s = nextRuleCoupon(empty, rule(), build);
    const spy = vi.fn(build);
    expect(nextRuleCoupon(s, rule(), spy)).toBe(s);
    expect(spy).not.toHaveBeenCalled();
  });

  it('an untouched suggestion follows: another rule replaces it, no rule clears it', () => {
    const s = nextRuleCoupon(empty, rule(), build);
    const other = nextRuleCoupon(s, rule({ id: 'r2', coupon_value: 10 }), build);
    expect(other.rule?.id).toBe('r2');
    expect(other.collectedCoupon?.coupon_value).toBe(10);
    const cleared = nextRuleCoupon(s, null, build);
    expect(cleared).toEqual(empty);
  });

  it('an ADJUSTED suggestion is the agent’s: never replaced or cleared', () => {
    const s = nextRuleCoupon(empty, rule(), build);
    const adjusted = {
      ...s,
      collectedCoupon: { ...s.collectedCoupon!, coupon_value: 45, max_discount: 45 },
    };
    expect(isAdjusted(adjusted)).toBe(true);
    expect(nextRuleCoupon(adjusted, rule({ id: 'r2' }), build)).toBe(adjusted);
    expect(nextRuleCoupon(adjusted, null, build)).toBe(adjusted);
  });

  it('the agent’s own coupon (no rule) is never replaced', () => {
    const own = { ...nextRuleCoupon(empty, rule(), build), rule: null };
    expect(nextRuleCoupon(own, rule({ id: 'r2' }), build)).toBe(own);
  });

  it('switched off: never pre-filled again on this form', () => {
    const declined = { ...empty, declined: true };
    expect(nextRuleCoupon(declined, rule(), build)).toBe(declined);
  });
});

describe('policyFields', () => {
  it('nothing without a rule - a plain request never names the new columns', () => {
    expect(policyFields(null, null)).toEqual({});
    const s = nextRuleCoupon(empty, rule(), build);
    expect(policyFields(null, s.collectedCoupon)).toEqual({});
    // Rules exist but none matched: marked, quietly, as outside the rules.
    expect(policyFields(null, s.collectedCoupon, true)).toEqual({ differs_from_policy: true });
  });

  it('accepted -> the rule, not differing; adjusted -> differing', () => {
    const s = nextRuleCoupon(empty, rule(), build);
    expect(policyFields(s.rule, s.collectedCoupon)).toEqual({
      policy_rule: 'r1',
      differs_from_policy: false,
    });
    expect(policyFields(s.rule, { ...s.collectedCoupon!, usage_limit: 2 })).toEqual({
      policy_rule: 'r1',
      differs_from_policy: true,
    });
  });
});
