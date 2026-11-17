import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_FIELD_SPEC,
  CAMPAIGN_OBJECTIVES,
  CampaignDraft,
  DEFAULT_MONEY_MODEL,
  LOCKED_WHEN_LIVE,
  OBJECTIVE_CATALOGUE,
  canApproveCampaign,
  discountPerOrder,
  forecastCampaign,
  objectiveSpec,
  offerLabel,
} from '../src/marketing-engine.js';

/* THE MARKETING PORTAL'S ENGINE CONTRACT (owner, 2026-11-15): the portal is
   built on these types and this forecast maths; Yiji v2 answers the same
   interface. The numbers below are hand-computed from DEFAULT_MONEY_MODEL. */

const base = CampaignDraft.parse({
  objective: 'REPEAT_PURCHASE',
  name: { en: 'Second order', ar: 'الطلب الثاني' },
  offer: { type: 'PERCENT', percent: 20, maxDiscountSar: 15 },
  limits: { totalRedemptions: 1000, budgetSar: 5000 },
  schedule: { startDate: '2026-11-16', endDate: '2026-12-16', expiresAfterIssueDays: 31 },
  scope: { orderTypes: ['DELIVERY'] },
  distribution: { channels: ['APP_WALLET'] },
  audience: { mode: 'ALL' },
});

describe('discountPerOrder', () => {
  it('caps a percentage at the maximum discount', () => {
    expect(discountPerOrder({ type: 'PERCENT', percent: 20, maxDiscountSar: 15 }, 100)).toBe(15);
    expect(discountPerOrder({ type: 'PERCENT', percent: 20, maxDiscountSar: 15 }, 50)).toBe(10);
  });
  it('never discounts more than the order for a fixed amount', () => {
    expect(discountPerOrder({ type: 'FIXED', amountSar: 25 }, 20)).toBe(20);
    expect(discountPerOrder({ type: 'FIXED', amountSar: 25 }, 80)).toBe(25);
  });
  it('covers the full delivery fee or the SAR amount chosen', () => {
    expect(discountPerOrder({ type: 'FREE_DELIVERY' }, 80)).toBe(12);
    expect(discountPerOrder({ type: 'FREE_DELIVERY', deliveryFeeCoveredSar: 10 }, 80)).toBe(10);
  });
});

describe('forecastCampaign', () => {
  const input = { customersMatched: 1000, redemptionRatePct: 10, avgOrderSar: 100 };

  it('counts the measurement group out of the reach and prices every redemption', () => {
    const f = forecastCampaign(
      { ...base, audience: { ...base.audience, controlGroupPct: 10 } },
      input,
    );
    // 1000 × 90% = 900 reached; 10% redeem = 90 orders at 15 SAR each.
    expect(f.expectedRedemptions).toBe(90);
    expect(f.discountSar).toBe(1350);
    expect(f.revenueSar).toBe(9000);
    // 25% would have ordered anyway: 68 extra orders × 100 × (100-32-4-18)% = 3128.
    expect(f.extraProfitSar).toBe(3128);
    expect(f.netSar).toBe(3128 - 1350);
    expect(f.needsApproval).toBe(false);
  });

  it('is capped by the budget and the total redemption limit', () => {
    const f = forecastCampaign(
      { ...base, limits: { ...base.limits, totalRedemptions: 50, budgetSar: 300 } },
      input,
    );
    expect(f.expectedRedemptions).toBe(50);
    expect(f.discountSar).toBe(300);
    expect(f.mostItCanCostSar).toBe(300);
  });

  it('adds the message cost of paid channels to the most it can cost', () => {
    const f = forecastCampaign(
      {
        ...base,
        audience: { ...base.audience, controlGroupPct: 0 },
        distribution: { ...base.distribution, channels: ['APP_WALLET', 'SMS'] },
      },
      input,
    );
    // 1000 reached × 0.09 SAR per SMS.
    expect(f.messageCostSar).toBe(90);
    expect(f.mostItCanCostSar).toBe(5090);
  });

  it('names every reason a second person is needed', () => {
    const big = forecastCampaign(
      {
        ...base,
        audience: { ...base.audience, controlGroupPct: 0 },
        offer: { type: 'PERCENT', percent: 90, maxDiscountSar: 100 },
        limits: { ...base.limits, totalRedemptions: 5000, budgetSar: 500_000 },
      },
      // 3000 redemptions × 90 SAR = 270,000 discount against 103,500 extra profit.
      { customersMatched: 5000, redemptionRatePct: 60, avgOrderSar: 100 },
    );
    expect(big.discountSar).toBe(270_000);
    expect(big.netSar).toBeLessThan(0);
    expect(big.needsApproval).toBe(true);
    expect(big.approvalReasons).toEqual(['cost_above_threshold', 'deep_discount', 'forecast_loss']);
    expect(DEFAULT_MONEY_MODEL.approvalAboveSar).toBe(20_000);
  });
});

describe('the objective catalogue and field specification', () => {
  it('has a recommended set-up for all sixteen objectives', () => {
    expect(CAMPAIGN_OBJECTIVES).toHaveLength(16);
    for (const key of CAMPAIGN_OBJECTIVES) {
      const spec = objectiveSpec(key);
      expect(spec.key).toBe(key);
      expect(spec.recommended.validityDays).toBeGreaterThan(0);
    }
    expect(OBJECTIVE_CATALOGUE.map((o) => o.key).sort()).toEqual([...CAMPAIGN_OBJECTIVES].sort());
  });

  it('lists every field once, across the seven steps, with a type and a default', () => {
    expect(CAMPAIGN_FIELD_SPEC).toHaveLength(107);
    const paths = CAMPAIGN_FIELD_SPEC.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(CAMPAIGN_FIELD_SPEC.map((f) => f.step))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    for (const f of CAMPAIGN_FIELD_SPEC) {
      expect(f.type).toBeTruthy();
      expect(['yes', 'no', 'conditional']).toContain(f.required);
    }
  });

  it('locks the fields a live campaign cannot change', () => {
    /* review 2026-11-16: every money field, not only the offer */
    expect(LOCKED_WHEN_LIVE).toEqual([
      'objective',
      'tenantId',
      'offer',
      'experiment',
      'trigger',
      'loyalty',
      'audience',
      'rules',
      'scope',
      'limits',
      'distribution',
      'stacking',
      'fraud',
      'schedule',
      'communication',
      'forecast',
      'studyId',
    ]);
  });

  it('refuses a draft without the mandatory limits or with a name too long', () => {
    expect(() => CampaignDraft.parse({ ...base, limits: {} })).toThrow();
    expect(() =>
      CampaignDraft.parse({ ...base, name: { en: 'x'.repeat(61), ar: 'ok' } }),
    ).toThrow();
  });

  it('describes an offer the way the customer reads it', () => {
    expect(offerLabel({ type: 'PERCENT', percent: 20, maxDiscountSar: 15 })).toMatch(/20%/);
    expect(offerLabel({ type: 'FIXED', amountSar: 25 })).toMatch(/25/);
  });
});

describe('canApproveCampaign (four eyes)', () => {
  it('refuses the creator, and anything not waiting for approval', () => {
    expect(canApproveCampaign({ createdBy: 'u1', status: 'waiting_approval' }, 'u1')).toEqual({
      ok: false,
      reason: 'own',
    });
    expect(canApproveCampaign({ createdBy: 'u1', status: 'draft' }, 'u2')).toEqual({
      ok: false,
      reason: 'status',
    });
    expect(canApproveCampaign({ createdBy: 'u1', status: 'waiting_approval' }, 'u2')).toEqual({
      ok: true,
    });
  });
});
