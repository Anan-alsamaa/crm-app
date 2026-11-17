import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_FIELD_SPEC,
  CampaignDraft,
  DEFAULT_MONEY_MODEL,
  campaignApprovalReasons,
  lockedFieldChanges,
  simulateCampaignCheckout,
  valueAtPath,
  type Campaign,
} from '../src/marketing-engine.js';

/* The rules the sample engine and the CRM's server engine share
   (owner, 2026-11-16): one implementation, so the browser and the server
   can never disagree about a lock, an approval reason or a checkout. */

const draft = CampaignDraft.parse({
  objective: 'REPEAT_PURCHASE',
  name: { en: 'Second order', ar: 'الطلب الثاني' },
  offer: { type: 'FIXED', amountSar: 7 },
  limits: { totalRedemptions: 3000, budgetSar: 5000 },
  validity: { startDate: '2026-11-01', endDate: '2026-11-30' },
});
const forecast = { messageCostSar: 0, netSar: 100, approvalReasons: [] as string[] };

describe('lockedFieldChanges', () => {
  it('locks nothing before the campaign is live', () => {
    const prev = { ...draft, status: 'approved' as const };
    expect(lockedFieldChanges(prev, { ...draft, offer: { ...draft.offer, amountSar: 9 } })).toEqual(
      [],
    );
  });
  it.each(['live', 'paused', 'ended'] as const)(
    'names every locked path a %s campaign would change',
    (status) => {
      const prev = { ...draft, status };
      const next = {
        ...draft,
        offer: { ...draft.offer, amountSar: 9 },
        validity: { ...draft.validity, startDate: '2026-11-02', endDate: '2026-12-30' },
        limits: { ...draft.limits, budgetSar: 9000 },
      };
      expect(lockedFieldChanges(prev, next)).toEqual(['offer', 'limits', 'validity']);
    },
  );
  it('reads dotted paths', () => {
    expect(valueAtPath(draft, 'validity.startDate')).toBe('2026-11-01');
    expect(valueAtPath(draft, 'distribution.code')).toBeUndefined();
  });
});

describe('campaignApprovalReasons', () => {
  it('needs none for a small fixed discount that makes money', () => {
    expect(campaignApprovalReasons(draft, forecast)).toEqual([]);
  });
  it('flags the cost ceiling: budget plus messages above the threshold', () => {
    const big = { ...draft, limits: { ...draft.limits, budgetSar: 19_990 } };
    expect(campaignApprovalReasons(big, { ...forecast, messageCostSar: 5 })).toEqual([]);
    expect(campaignApprovalReasons(big, { ...forecast, messageCostSar: 20 })).toEqual([
      'cost_above_threshold',
    ]);
  });
  it('flags a deep percentage or cashback, and a forecast loss', () => {
    const deep = { ...draft, offer: { ...draft.offer, type: 'PERCENT' as const, percent: 60 } };
    expect(campaignApprovalReasons(deep, forecast)).toEqual(['deep_discount']);
    const cash = { ...draft, offer: { ...draft.offer, type: 'CASHBACK' as const, percent: 55 } };
    expect(campaignApprovalReasons(cash, { ...forecast, netSar: -1 })).toEqual([
      'deep_discount',
      'forecast_loss',
    ]);
  });
  it('never drops a reason the page already found, and follows the money model', () => {
    expect(
      campaignApprovalReasons(draft, { ...forecast, approvalReasons: ['cost_above_threshold'] }),
    ).toEqual(['cost_above_threshold']);
    expect(
      campaignApprovalReasons(draft, forecast, { ...DEFAULT_MONEY_MODEL, approvalAboveSar: 1000 }),
    ).toEqual(['cost_above_threshold']);
  });
});

describe('simulateCampaignCheckout', () => {
  const c = draft as unknown as Campaign;
  const input = {
    brandId: '1',
    orderType: 'DELIVERY' as const,
    subtotalSar: 85,
    otherOffer: false,
    otherCoupon: false,
    loyalty: true,
  };
  it('applies the discount and the loyalty order', () => {
    expect(simulateCampaignCheckout(c, input)).toEqual({
      allowed: true,
      discountSar: 7,
      message: 'SAR 7 off applied.',
      appliedOrder: ['COUPON', 'LOYALTY'],
    });
  });
  it('refuses unknown, stacked, below minimum, wrong brand and wrong order type', () => {
    expect(simulateCampaignCheckout(null, input).reason).toBe('unknown');
    expect(simulateCampaignCheckout(c, { ...input, otherOffer: true }).reason).toBe(
      'stacking_offer',
    );
    expect(simulateCampaignCheckout(c, { ...input, otherCoupon: true }).reason).toBe(
      'stacking_coupon',
    );
    const min = { ...c, rules: { ...c.rules, minOrderSar: 100 } };
    expect(simulateCampaignCheckout(min, input).reason).toBe('min_order');
    const brand = { ...c, scope: { ...c.scope, brandIds: ['3'] } };
    expect(simulateCampaignCheckout(brand, input).reason).toBe('scope_brand');
    expect(simulateCampaignCheckout(c, { ...input, orderType: 'DINE_IN' }).reason).toBe(
      'scope_order_type',
    );
  });
});

describe('the field specification', () => {
  /* The docs say 84; the encoded list holds 83 unique paths (2026-11-16).
     Pinned so a field added or lost is a visible change, not a silent one. */
  it('has 83 fields, every path unique', () => {
    expect(CAMPAIGN_FIELD_SPEC).toHaveLength(83);
    expect(new Set(CAMPAIGN_FIELD_SPEC.map((f) => f.path)).size).toBe(83);
  });
});
