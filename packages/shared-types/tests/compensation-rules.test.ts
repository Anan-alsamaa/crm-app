import { describe, it, expect } from 'vitest';
import {
  CouponRequestDraftChecked,
  compensationRuleProblems,
  differsFromPolicy,
  effectivePrivileges,
  parseRuleCouponLimit,
  pickCompensationRule,
  policyDifferences,
  ruleCouponCountFilter,
  ruleCouponDraft,
  ruleCouponTerms,
  ruleLimitReached,
  ruleLimitSince,
  ruleMatches,
  ruleSpecificity,
  PRIVILEGE_GROUP,
  PRIVILEGE_PORTAL,
  type CompensationRule,
} from '../src/index.js';

const rule = (over: Partial<CompensationRule> = {}): CompensationRule => ({
  id: 'r',
  name: 'Rule',
  active: true,
  priority: 0,
  complaint_type: 'Late order',
  discount_category: 'Amount',
  coupon_value: 20,
  ...over,
});

const TODAY = new Date('2026-10-27T09:00:00.000Z');

describe('ruleMatches', () => {
  it('matches the complaint type case-insensitively', () => {
    expect(ruleMatches(rule(), { complaintType: ' late ORDER ' })).toBe(true);
    expect(ruleMatches(rule(), { complaintType: 'Missing item' })).toBe(false);
    expect(ruleMatches(rule(), { complaintType: null })).toBe(false);
  });

  it('a set service type must match; an empty one matches any', () => {
    const r = rule({ service_type: 'Delivery' });
    expect(ruleMatches(r, { complaintType: 'Late order', serviceType: 'delivery' })).toBe(true);
    expect(ruleMatches(r, { complaintType: 'Late order', serviceType: 'Pickup' })).toBe(false);
    expect(ruleMatches(r, { complaintType: 'Late order' })).toBe(false);
    expect(ruleMatches(rule(), { complaintType: 'Late order', serviceType: 'Pickup' })).toBe(true);
  });

  it('a minimum delay needs a KNOWN delay at least that long', () => {
    const r = rule({ min_delay_minutes: 45 });
    expect(ruleMatches(r, { complaintType: 'Late order', delayMinutes: 45 })).toBe(true);
    expect(ruleMatches(r, { complaintType: 'Late order', delayMinutes: 44 })).toBe(false);
    expect(ruleMatches(r, { complaintType: 'Late order' })).toBe(false);
  });

  it('order value bounds are inclusive and need a KNOWN value', () => {
    const r = rule({ min_order_value: 50, max_order_value: 100 });
    expect(ruleMatches(r, { complaintType: 'Late order', orderValue: 50 })).toBe(true);
    expect(ruleMatches(r, { complaintType: 'Late order', orderValue: 100 })).toBe(true);
    expect(ruleMatches(r, { complaintType: 'Late order', orderValue: 49.99 })).toBe(false);
    expect(ruleMatches(r, { complaintType: 'Late order', orderValue: 100.5 })).toBe(false);
    expect(ruleMatches(r, { complaintType: 'Late order', orderValue: null })).toBe(false);
  });
});

describe('pickCompensationRule', () => {
  const input = {
    complaintType: 'Late order',
    serviceType: 'Delivery',
    delayMinutes: 70,
    orderValue: 120,
  };

  it('no match -> null', () => {
    expect(pickCompensationRule([rule({ complaint_type: 'Order cold' })], input)).toBeNull();
    expect(pickCompensationRule([], input)).toBeNull();
  });

  it('skips inactive rules', () => {
    const off = rule({ id: 'off', active: false, service_type: 'Delivery' });
    const on = rule({ id: 'on' });
    expect(pickCompensationRule([off, on], input)?.id).toBe('on');
    expect(pickCompensationRule([off], input)).toBeNull();
  });

  it('the most specific rule wins, whatever its priority', () => {
    const general = rule({ id: 'general', priority: 100 });
    const specific = rule({ id: 'specific', service_type: 'Delivery', min_delay_minutes: 60 });
    expect(ruleSpecificity(specific)).toBe(2);
    expect(pickCompensationRule([general, specific], input)?.id).toBe('specific');
  });

  it('equally specific: the higher priority wins, then the older, then the id', () => {
    const a = rule({ id: 'a', service_type: 'Delivery', priority: 1 });
    const b = rule({ id: 'b', min_delay_minutes: 30, priority: 5 });
    expect(pickCompensationRule([a, b], input)?.id).toBe('b');
    const old = rule({ id: 'z', date_created: '2026-01-01T00:00:00Z' });
    const young = rule({ id: 'y', date_created: '2026-06-01T00:00:00Z' });
    expect(pickCompensationRule([young, old], input)?.id).toBe('z');
    expect(pickCompensationRule([rule({ id: 'q' }), rule({ id: 'p' })], input)?.id).toBe('p');
  });
});

describe('the coupon a rule suggests', () => {
  it('an Amount: the cap IS the amount; defaults Private / Customer Care / All / once', () => {
    const t = ruleCouponTerms(rule({ coupon_value: 25 }), TODAY);
    expect(t).toMatchObject({
      discount_category: 'Amount',
      coupon_value: 25,
      coupon_percent: null,
      max_discount: 25,
      usage_limit: 1,
      delivery_type: 'All',
      coupon_type: 'Private',
      issuing_side: 'Customer Care',
      no_other_discounts: false,
      valid_from: '2026-10-27',
      // No validity set: the standard one month.
      valid_to: '2026-11-27',
    });
  });

  it('a Percentage carries its percent and cap; validity is whole days inclusive', () => {
    const t = ruleCouponTerms(
      rule({
        discount_category: 'Percentage',
        coupon_value: 99, // ignored for a percentage
        coupon_percent: 20,
        max_discount: 40,
        validity_days: 7,
        issuing_side: 'operations',
        delivery_type: 'Delivery, Pickup',
        usage_limit: 2,
      }),
      TODAY,
    );
    expect(t.coupon_value).toBeNull();
    expect(t.coupon_percent).toBe(20);
    expect(t.max_discount).toBe(40);
    expect(t.valid_to).toBe('2026-11-02');
    expect(t.issuing_side).toBe('Operations');
    expect(t.delivery_type).toBe('Delivery, Pickup');
    expect(t.usage_limit).toBe(2);
  });

  it('a full draft passes the same validation an agent’s coupon does', () => {
    const d = ruleCouponDraft(rule(), {
      today: TODAY,
      title: '0501234567',
      code: 'CC-ABCDEFGH',
      reason: 'Late',
      restaurantId: '501',
    });
    expect(CouponRequestDraftChecked.safeParse(d).success).toBe(true);
    expect(d.delivery_excluded).toBe(false);
  });
});

describe('differs from policy', () => {
  const policy = ruleCouponDraft(rule({ coupon_value: 30 }), {
    today: TODAY,
    title: 't',
    code: 'CC-1',
  });

  it('accepted as suggested: no difference, even a day later or with another title/reason', () => {
    const nextDay = ruleCouponDraft(rule({ coupon_value: 30 }), {
      today: new Date('2026-10-28T09:00:00Z'),
      title: 'other',
      code: 'CC-2',
      reason: 'typed by the agent',
    });
    expect(differsFromPolicy(policy, nextDay)).toBe(false);
    expect(differsFromPolicy(policy, { ...policy, delivery_type: 'All' })).toBe(false);
  });

  it('flags each adjusted term', () => {
    expect(policyDifferences(policy, { ...policy, coupon_value: 50, max_discount: 50 })).toEqual([
      'coupon_value',
      'max_discount',
    ]);
    expect(policyDifferences(policy, { ...policy, valid_to: '2026-12-31' })).toEqual(['validity']);
    expect(policyDifferences(policy, { ...policy, usage_limit: 3 })).toEqual(['usage_limit']);
    expect(policyDifferences(policy, { ...policy, coupon_type: 'Public' })).toEqual([
      'coupon_type',
    ]);
    expect(policyDifferences(policy, { ...policy, issuing_side: 'Operations' })).toEqual([
      'issuing_side',
    ]);
    expect(policyDifferences(policy, { ...policy, no_other_discounts: true })).toEqual([
      'no_other_discounts',
    ]);
    expect(
      policyDifferences(policy, { ...policy, discount_category: 'Percentage', coupon_percent: 10 }),
    ).toContain('discount_category');
  });

  it('delivery types compare as a set, not as a string', () => {
    const a = { ...policy, delivery_type: 'Delivery, Pickup' };
    expect(differsFromPolicy(a, { ...a, delivery_type: 'Pickup,Delivery' })).toBe(false);
    expect(differsFromPolicy(a, { ...a, delivery_type: 'Pickup' })).toBe(true);
  });
});

describe('compensationRuleProblems (the rule editor)', () => {
  it('a complete rule has none', () => {
    expect(compensationRuleProblems(rule())).toEqual({});
  });

  it('names what is missing or contradictory', () => {
    const p = compensationRuleProblems({
      name: ' ',
      complaint_type: '',
      discount_category: 'Percentage',
      coupon_percent: 120,
      min_order_value: 100,
      max_order_value: 50,
      validity_days: 0,
      usage_limit: 0,
    });
    expect(Object.keys(p).sort()).toEqual(
      [
        'name',
        'complaint_type',
        'coupon_percent',
        'max_discount',
        'max_order_value',
        'validity_days',
        'usage_limit',
      ].sort(),
    );
    expect(compensationRuleProblems(rule({ coupon_value: 0 })).coupon_value).toBeTruthy();
    expect(
      compensationRuleProblems(rule({ discount_category: '' })).discount_category,
    ).toBeTruthy();
  });
});

describe('the per-customer limit (default off)', () => {
  it('off unless a complete, enabled setting exists', () => {
    expect(parseRuleCouponLimit(null)).toBeNull();
    expect(parseRuleCouponLimit('not json')).toBeNull();
    expect(parseRuleCouponLimit({ enabled: false, maxPerCustomer: 2, windowDays: 30 })).toBeNull();
    expect(parseRuleCouponLimit({ maxPerCustomer: 0, windowDays: 30 })).toBeNull();
    expect(parseRuleCouponLimit('{"enabled":true,"maxPerCustomer":2,"windowDays":30}')).toEqual({
      maxPerCustomer: 2,
      windowDays: 30,
    });
  });

  it('reached at the cap, never when off', () => {
    const limit = { maxPerCustomer: 2, windowDays: 30 };
    expect(ruleLimitReached(1, limit)).toBe(false);
    expect(ruleLimitReached(2, limit)).toBe(true);
    expect(ruleLimitReached(100, null)).toBe(false);
    expect(ruleLimitSince(limit, TODAY)).toBe('2026-09-27T09:00:00.000Z');
  });

  it('counts only this customer’s non-rejected RULE coupons in the window', () => {
    expect(ruleCouponCountFilter('c1', '2026-09-27T00:00:00Z')).toEqual({
      _and: [
        { contact: { _eq: 'c1' } },
        { policy_rule: { _nnull: true } },
        { date_created: { _gte: '2026-09-27T00:00:00Z' } },
        { status: { _neq: 'rejected' } },
      ],
    });
  });
});

describe('manage_compensation_rules privilege', () => {
  it('defaults to the Administrator and WeCare Admin only', () => {
    expect(effectivePrivileges(null, 'Administrator').manage_compensation_rules).toBe(true);
    expect(effectivePrivileges({}, 'WeCare Admin').manage_compensation_rules).toBe(true);
    expect(
      effectivePrivileges({ approve_coupons: true }, 'WeCare Supervisor').manage_compensation_rules,
    ).toBe(false);
    expect(effectivePrivileges({}, 'WeCare Agent').manage_compensation_rules).toBe(false);
  });

  it('a stored tick wins either way', () => {
    expect(
      effectivePrivileges({ manage_compensation_rules: true }, 'WeCare Supervisor')
        .manage_compensation_rules,
    ).toBe(true);
    expect(
      effectivePrivileges({ manage_compensation_rules: false }, 'WeCare Admin')
        .manage_compensation_rules,
    ).toBe(false);
  });

  it('sits with the coupons, on the admin portal', () => {
    expect(PRIVILEGE_GROUP.manage_compensation_rules).toBe('coupons');
    expect(PRIVILEGE_PORTAL.manage_compensation_rules).toBe('admin');
  });
});
