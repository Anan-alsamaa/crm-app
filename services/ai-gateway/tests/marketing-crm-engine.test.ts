import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_FIELD_SPEC,
  DEFAULT_MONEY_MODEL,
  marketingCouponProblems,
  valueAtPath,
  type Campaign,
  type MarketingCouponDraft,
  type Study,
} from '@yiji/shared-types';
import {
  CrmMarketingEngine,
  EngineRefusal,
  inControlGroup,
  mergeMoneyModel,
} from '../src/marketing/crm-engine.js';
import { issuanceBlockers } from '../src/marketing/campaign-coupon.js';
import {
  MemoryEngineStore,
  admin,
  checker,
  forecastFor,
  issuableDraft,
  maker,
  viewer,
} from './marketing-engine-fixture.js';

const NOW = new Date('2026-11-16T09:00:00Z');

function setup() {
  const store = new MemoryEngineStore();
  let r = 0.37;
  const engine = new CrmMarketingEngine(store, {
    now: () => NOW,
    random: () => (r = ((r * 9301 + 49297) % 233280) / 233280),
  });
  return { store, engine };
}

async function refusal(p: Promise<unknown>): Promise<EngineRefusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof EngineRefusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

/** maker creates and submits, checker approves: an approved campaign. */
async function approved(engine: CrmMarketingEngine, draft = issuableDraft()): Promise<Campaign> {
  const c = await engine.saveCampaign(maker, draft);
  await engine.submitForApproval(maker, c.id, { forecast: forecastFor() });
  return engine.decideCampaign(checker, c.id, { decision: 'approve', note: 'ok' });
}

describe('campaigns: who may do what', () => {
  it('only someone who prepares marketing work may create, edit, submit or move a campaign', async () => {
    const { engine } = setup();
    expect((await refusal(engine.saveCampaign(viewer, issuableDraft()))).code).toBe(
      'manage_marketing_required',
    );
    expect((await refusal(engine.saveCampaign(checker, issuableDraft()))).status).toBe(403);
    const c = await engine.saveCampaign(maker, issuableDraft());
    expect(c).toMatchObject({ status: 'draft', createdBy: 'user-maker' });
    expect(c.id).toMatch(/^CMP-\d{4}-\d{4}$/);
    expect((await refusal(engine.submitForApproval(viewer, c.id, {}))).status).toBe(403);
    expect(
      (await refusal(engine.setCampaignStatus(checker, c.id, { status: 'live' }))).status,
    ).toBe(403);
  });

  it('only someone who approves marketing work may decide', async () => {
    const { engine } = setup();
    const c = await engine.saveCampaign(maker, issuableDraft());
    await engine.submitForApproval(maker, c.id, { forecast: forecastFor() });
    const r = await refusal(engine.decideCampaign(viewer, c.id, { decision: 'approve' }));
    expect(r).toMatchObject({ status: 403, code: 'approve_marketing_required' });
  });

  it('the creator never decides their own campaign - not even the Administrator', async () => {
    const { engine } = setup();
    const own = await engine.saveCampaign(admin, issuableDraft());
    await engine.submitForApproval(admin, own.id, { forecast: forecastFor() });
    const r = await refusal(engine.decideCampaign(admin, own.id, { decision: 'approve' }));
    expect(r).toMatchObject({ status: 403, code: 'own_campaign' });
    const ok = await engine.decideCampaign(checker, own.id, { decision: 'approve', note: 'fine' });
    expect(ok.status).toBe('approved');
    expect(ok.approval).toMatchObject({ requestedBy: 'user-admin', decidedBy: 'user-checker' });
  });

  it('a person who both prepares and approves still cannot approve their own', async () => {
    const { engine } = setup();
    const both = { ...maker, privileges: { ...maker.privileges, approve_marketing: true } };
    const c = await engine.saveCampaign(both, issuableDraft());
    await engine.submitForApproval(both, c.id, { forecast: forecastFor() });
    expect((await refusal(engine.decideCampaign(both, c.id, { decision: 'approve' }))).code).toBe(
      'own_campaign',
    );
  });

  it('decides only a campaign waiting for approval (409)', async () => {
    const { engine } = setup();
    const c = await engine.saveCampaign(maker, issuableDraft());
    const r = await refusal(engine.decideCampaign(checker, c.id, { decision: 'approve' }));
    expect(r).toMatchObject({ status: 409, code: 'not_waiting_approval' });
  });

  it('a rejection keeps the note and lets the author fix and resubmit', async () => {
    const { engine } = setup();
    const c = await engine.saveCampaign(maker, issuableDraft());
    await engine.submitForApproval(maker, c.id, { forecast: forecastFor() });
    const rej = await engine.decideCampaign(checker, c.id, {
      decision: 'reject',
      note: 'too deep',
    });
    expect(rej).toMatchObject({ status: 'rejected', approval: { note: 'too deep' } });
    const again = await engine.submitForApproval(maker, c.id, { forecast: forecastFor() });
    expect(again.status).toBe('waiting_approval');
    expect(again.approval.decidedBy).toBeNull();
  });

  it('refuses an invalid draft with the field named (422)', async () => {
    const { engine } = setup();
    const bad = { ...issuableDraft(), name: { en: '', ar: 'x' } };
    const r = await refusal(engine.saveCampaign(maker, bad));
    expect(r).toMatchObject({ status: 422, code: 'invalid_campaign' });
    expect((r.detail as { field: string }).field).toBe('name.en');
  });

  it('an unknown campaign is 404 for every action, null for a read', async () => {
    const { engine } = setup();
    expect(await engine.getCampaign('CMP-0000-0000')).toBeNull();
    expect((await refusal(engine.saveCampaign(maker, issuableDraft(), 'CMP-x'))).status).toBe(404);
    expect((await refusal(engine.performance('CMP-x'))).status).toBe(404);
  });
});

describe('the approval threshold and the deep-discount rule, on the server', () => {
  it('recomputes the reasons from the draft - a page claiming "no approval needed" is overruled', async () => {
    const { engine } = setup();
    const c = await engine.saveCampaign(
      maker,
      issuableDraft({
        offer: { ...issuableDraft().offer, type: 'PERCENT', percent: 60, maxDiscountSar: 30 },
        limits: { ...issuableDraft().limits, budgetSar: 25_000 },
      }),
    );
    const sent = await engine.submitForApproval(maker, c.id, {
      forecast: forecastFor({ needsApproval: false, approvalReasons: [], mostItCanCostSar: 1 }),
    });
    expect(sent.snapshot).toMatchObject({
      needsApproval: true,
      approvalReasons: ['cost_above_threshold', 'deep_discount'],
      mostItCanCostSar: 25_000,
    });
  });

  it('uses the finance setting when there is one', async () => {
    const { engine, store } = setup();
    store.moneyModel = JSON.stringify({ approvalAboveSar: 1000, version: '2026-12' });
    const c = await engine.saveCampaign(maker, issuableDraft());
    const sent = await engine.submitForApproval(maker, c.id, { forecast: forecastFor() });
    expect(sent.snapshot!.approvalReasons).toEqual(['cost_above_threshold']);
    expect((await engine.moneyModel()).version).toBe('2026-12');
  });

  it('re-judges the reasons at the decision, against the money model of that day', async () => {
    const { engine, store } = setup();
    const c = await engine.saveCampaign(maker, issuableDraft());
    await engine.submitForApproval(maker, c.id, { forecast: forecastFor() });
    store.moneyModel = { approvalAboveSar: 100 };
    const ok = await engine.decideCampaign(checker, c.id, { decision: 'approve' });
    expect(ok.snapshot!.approvalReasons).toEqual(['cost_above_threshold']);
    expect(store.activity.at(-1)).toMatchObject({
      action: 'approved',
      detail: { approvalReasons: ['cost_above_threshold'], by: 'user-checker' },
    });
  });

  it('refuses a malformed forecast and submitting twice', async () => {
    const { engine } = setup();
    const c = await engine.saveCampaign(maker, issuableDraft());
    expect((await refusal(engine.submitForApproval(maker, c.id, { forecast: {} }))).code).toBe(
      'invalid_forecast',
    );
    await engine.submitForApproval(maker, c.id, { forecast: forecastFor() });
    expect(
      (await refusal(engine.submitForApproval(maker, c.id, { forecast: forecastFor() }))).code,
    ).toBe('not_submittable');
  });

  it('keeps a malformed finance setting from breaking the model', () => {
    expect(mergeMoneyModel('not json')).toEqual(DEFAULT_MONEY_MODEL);
    expect(mergeMoneyModel({ foodCostPct: -3, channelCostPct: { PICKUP: 4 } })).toMatchObject({
      foodCostPct: 32,
      channelCostPct: { PICKUP: 4, DELIVERY: 18 },
    });
  });
});

describe('LOCKED_WHEN_LIVE and edits after approval', () => {
  it('refuses a change to a locked field once live, and allows the rest', async () => {
    const { engine } = setup();
    const c = await approved(engine);
    await engine.setCampaignStatus(maker, c.id, { status: 'live' });
    const draft = issuableDraft();
    const r = await refusal(
      engine.saveCampaign(maker, { ...draft, offer: { ...draft.offer, amountSar: 15 } }, c.id),
    );
    expect(r).toMatchObject({
      status: 422,
      code: 'locked_while_live',
      detail: { fields: ['offer'] },
    });
    const r2 = await refusal(
      engine.saveCampaign(
        maker,
        {
          ...draft,
          audience: { ...draft.audience, controlGroupPct: 5 },
          rules: { ...draft.rules, minOrderSar: 1 },
        },
        c.id,
      ),
    );
    expect((r2.detail as { fields: string[] }).fields).toEqual(['audience', 'rules']);
    const ok = await engine.saveCampaign(
      maker,
      { ...draft, limits: { ...draft.limits, budgetSar: 9000 } },
      c.id,
    );
    expect(ok).toMatchObject({ status: 'live', limits: { budgetSar: 9000 } });
  });

  it('the same lock holds while paused and once ended', async () => {
    const { engine } = setup();
    const c = await approved(engine);
    await engine.setCampaignStatus(maker, c.id, { status: 'live' });
    await engine.setCampaignStatus(maker, c.id, { status: 'paused' });
    const d = issuableDraft();
    const bad = { ...d, validity: { ...d.validity, startDate: '2026-11-11' } };
    expect((await refusal(engine.saveCampaign(maker, bad, c.id))).code).toBe('locked_while_live');
    await engine.setCampaignStatus(maker, c.id, { status: 'ended' });
    expect((await refusal(engine.saveCampaign(maker, bad, c.id))).code).toBe('locked_while_live');
  });

  it('editing an approved campaign withdraws the approval; saving it unchanged does not', async () => {
    const { engine } = setup();
    const c = await approved(engine);
    const same = await engine.saveCampaign(maker, issuableDraft(), c.id);
    expect(same.status).toBe('approved');
    const d = issuableDraft();
    const edited = await engine.saveCampaign(
      maker,
      { ...d, offer: { ...d.offer, amountSar: 12 } },
      c.id,
    );
    expect(edited).toMatchObject({
      status: 'draft',
      snapshot: null,
      approval: { decidedBy: null },
    });
    expect(edited.changeLog.at(-1)!.what).toBe('edited after approval - approval withdrawn');
  });

  it('nothing moves under an approver: no edits while waiting for approval', async () => {
    const { engine } = setup();
    const c = await engine.saveCampaign(maker, issuableDraft());
    await engine.submitForApproval(maker, c.id, { forecast: forecastFor() });
    expect((await refusal(engine.saveCampaign(maker, issuableDraft(), c.id))).status).toBe(409);
  });

  it('goes live only from approved, and moves only along the allowed steps', async () => {
    const { engine } = setup();
    const c = await engine.saveCampaign(maker, issuableDraft());
    const r = await refusal(engine.setCampaignStatus(maker, c.id, { status: 'live' }));
    expect(r).toMatchObject({ status: 409, code: 'bad_transition', detail: { from: 'draft' } });
    const a = await approved(engine);
    expect((await refusal(engine.setCampaignStatus(maker, a.id, { status: 'paused' }))).code).toBe(
      'bad_transition',
    );
    expect((await engine.setCampaignStatus(maker, a.id, { status: 'live' })).status).toBe('live');
    expect((await engine.setCampaignStatus(maker, a.id, { status: 'ended' })).status).toBe('ended');
    expect((await refusal(engine.setCampaignStatus(maker, a.id, { status: 'live' }))).code).toBe(
      'bad_transition',
    );
    expect((await refusal(engine.setCampaignStatus(maker, a.id, { status: 'x' }))).status).toBe(
      422,
    );
  });
});

describe('issuance through the existing marketing coupon pipeline', () => {
  it('writes ONE list coupon for the sender: approved by the approver, linked to the campaign', async () => {
    const { engine, store } = setup();
    const c = await approved(engine);
    await engine.setCampaignStatus(maker, c.id, { status: 'live' });
    const res = await engine.issue(maker, {
      campaignId: c.id,
      customerIds: ['0551234567', '+966 55 765 4321'],
    });
    expect(res).toMatchObject({ requested: 2, issued: 2, skipped: [] });
    expect(store.coupons).toHaveLength(1);
    const row = store.coupons[0]!.row;
    expect(row).toMatchObject({
      status: 'approved',
      decided_by: 'user-checker',
      audience: 'list',
      campaign: store.campaigns[0]!.id,
      discount_category: 'Amount',
      coupon_value: 10,
      order_minimum: 50,
      valid_from: '2026-11-10',
      valid_to: '2026-12-10',
      total_uses: 2,
      uses_per_customer: 1,
      delivery_type: 'Delivery,Pickup,Carhop',
      yiji_brand_id: null,
      no_other_discounts: true,
    });
    expect(res.batchId).toBe(row.code);
    /* The sender's own checks pass on what was written. */
    expect(marketingCouponProblems(row as unknown as MarketingCouponDraft)).toEqual([]);
    expect(store.recipients.map((r) => [r.phone, r.status])).toEqual([
      ['0551234567', 'queued'],
      ['0557654321', 'queued'],
    ]);
    expect(store.activity.at(-1)).toMatchObject({ action: 'issued', subject_id: c.id });
  });

  it('a capped percentage with one brand maps to a Percentage coupon on that brand', async () => {
    const { engine, store } = setup();
    const d = issuableDraft();
    const c = await approved(
      engine,
      issuableDraft({
        offer: { ...d.offer, type: 'PERCENT', percent: 20, maxDiscountSar: 25 },
        scope: { ...d.scope, brandIds: ['3'], orderTypes: ['PICKUP'] },
        stacking: {
          combineWithOtherOffers: true,
          combineWithLoyalty: true,
          combineWithOtherCoupons: false,
        },
        limits: { ...d.limits, perCustomerMode: 'MONTHLY', perCustomerMax: 2 },
      }),
    );
    await engine.issue(maker, { campaignId: c.id, customerIds: ['0551234567'] });
    expect(store.coupons[0]!.row).toMatchObject({
      discount_category: 'Percentage',
      coupon_percent: 20,
      max_discount: 25,
      yiji_brand_id: 3,
      brand_name: 'Okashi',
      delivery_type: 'Pickup',
      no_other_discounts: false,
      uses_per_customer: 2,
      total_uses: 2,
    });
  });

  it('resolves Yiji customer ids through CRM contacts and says who was skipped and why', async () => {
    const { engine, store } = setup();
    store.contacts.set('yiji-77', '+966551112222');
    const c = await approved(engine);
    const res = await engine.issue(maker, {
      campaignId: c.id,
      customerIds: ['yiji-77', 'yiji-unknown', '0551112222', '12345'],
    });
    expect(res.issued).toBe(1);
    expect(res.skipped).toEqual([
      { customerId: 'yiji-unknown', reason: 'no Saudi mobile number for this customer' },
      { customerId: '0551112222', reason: 'listed twice' },
      { customerId: '12345', reason: 'no Saudi mobile number for this customer' },
    ]);
    const again = await engine.issue(maker, { campaignId: c.id, customerIds: ['0551112222'] });
    expect(again).toMatchObject({
      issued: 0,
      batchId: '',
      skipped: [{ reason: 'already holds this coupon' }],
    });
    expect(store.coupons).toHaveLength(1);
  });

  it('never past the redemption or budget ceiling', async () => {
    const { engine } = setup();
    const d = issuableDraft();
    /* SAR 10 a coupon, SAR 25 budget: at most 2 customers. */
    const c = await approved(engine, issuableDraft({ limits: { ...d.limits, budgetSar: 25 } }));
    const res = await engine.issue(maker, {
      campaignId: c.id,
      customerIds: ['0551000001', '0551000002', '0551000003'],
    });
    expect(res.issued).toBe(2);
    expect(res.skipped).toEqual([
      { customerId: '0551000003', reason: 'campaign limit reached (redemptions or budget)' },
    ]);
    const c2 = await approved(
      engine,
      issuableDraft({ limits: { ...d.limits, totalRedemptions: 1 } }),
    );
    expect(
      (await engine.issue(maker, { campaignId: c2.id, customerIds: ['0551000001', '0551000002'] }))
        .issued,
    ).toBe(1);
  });

  it('holds back the control group, the same people every time', async () => {
    const { engine } = setup();
    const d = issuableDraft();
    const c = await approved(
      engine,
      issuableDraft({ audience: { ...d.audience, controlGroupPct: 20 } }),
    );
    const phones = Array.from({ length: 200 }, (_, i) => `05510${String(i).padStart(5, '0')}`);
    const res = await engine.issue(maker, { campaignId: c.id, customerIds: phones });
    const held = res.skipped.filter((s) => s.reason.startsWith('control group'));
    expect(held.length).toBeGreaterThan(20);
    expect(held.length).toBeLessThan(60);
    expect(held.every((h) => inControlGroup(c.id, h.customerId, 20))).toBe(true);
    expect(inControlGroup(c.id, '0551000001', 0)).toBe(false);
  });

  it('only after approval, by someone who prepares, never to "everyone"', async () => {
    const { engine } = setup();
    const draft = await engine.saveCampaign(maker, issuableDraft());
    expect(
      (await refusal(engine.issue(maker, { campaignId: draft.id, customerIds: ['0551234567'] })))
        .code,
    ).toBe('not_issuable_status');
    const c = await approved(engine);
    expect(
      (await refusal(engine.issue(checker, { campaignId: c.id, customerIds: ['0551234567'] })))
        .status,
    ).toBe(403);
    const d = issuableDraft();
    const all = await approved(engine, issuableDraft({ audience: { ...d.audience, mode: 'ALL' } }));
    expect(
      (await refusal(engine.issue(maker, { campaignId: all.id, customerIds: ['0551234567'] })))
        .code,
    ).toBe('audience_all');
    expect((await refusal(engine.issue(maker, { campaignId: c.id, customerIds: [] }))).status).toBe(
      422,
    );
  });

  it('refuses a campaign the v1 coupon cannot carry, naming every such field - never wider than approved', async () => {
    const { engine, store } = setup();
    const d = issuableDraft();
    const c = await approved(
      engine,
      issuableDraft({
        offer: { ...d.offer, type: 'FREE_DELIVERY', deliveryFeeCovered: 'FULL' },
        scope: { ...d.scope, branchIds: ['b-1'], brandIds: ['1', '3'] },
        validity: { ...d.validity, startTime: '14:00', daysOfWeek: [0, 1] },
        rules: { ...d.rules, maxOrderSar: 200, paymentMethods: ['CARD'] },
      }),
    );
    const r = await refusal(engine.issue(maker, { campaignId: c.id, customerIds: ['0551234567'] }));
    expect(r).toMatchObject({ status: 422, code: 'not_issuable' });
    expect((r.detail as { fields: string[] }).fields).toEqual([
      'offer.type',
      'rules.maxOrderSar',
      'rules.paymentMethods[]',
      'scope.brandIds[]',
      'scope.branchIds[]',
      'validity.startTime',
      'validity.daysOfWeek[]',
    ]);
    expect(store.coupons).toHaveLength(0);
  });

  it('lists every other blocker', () => {
    const d = issuableDraft();
    const c = {
      ...d,
      offer: {
        ...d.offer,
        type: 'PERCENT' as const,
        percent: 10,
        partialRedemption: {
          enabled: true,
          balanceExpiry: 'SAME' as const,
          onOrderCancel: 'RESTORE' as const,
        },
      },
      experiment: { ...d.experiment, enabled: true },
      loyalty: {
        stampsRequired: 5,
        stampExpiryDays: 60,
        milestones: [],
        minOrderToCountSar: 30,
        countOrdersFrom: 'ANY' as const,
        repeat: true,
        progressMessages: true,
      },
      rules: { ...d.rules, previousOrders: 'NONE' as const, firstOrderOnly: true },
      scope: {
        ...d.scope,
        brandIds: ['nope'],
        categoryIds: ['c'],
        productIds: ['p'],
        excludedProductIds: ['x'],
      },
      limits: { ...d.limits, perCustomerMode: 'UNLIMITED' as const, dailyRedemptions: 5 },
      validity: { ...d.validity, endTime: '17:00', endDate: '2026-11-01' },
      distribution: { ...d.distribution, codeType: 'SHARED' as const, code: 'WELCOME40' },
    } as unknown as Campaign;
    expect(issuanceBlockers(c, '2026-11-16')).toEqual([
      'offer.maxDiscountSar',
      'offer.partialRedemption.enabled',
      'experiment.enabled',
      'loyalty.stampsRequired',
      'rules.previousOrders',
      'rules.firstOrderOnly',
      'scope.brandIds[]',
      'scope.categoryIds[]',
      'scope.productIds[]',
      'scope.excludedProductIds[]',
      'limits.perCustomerMax',
      'limits.dailyRedemptions',
      'validity.endTime',
      'validity.endDate',
      'distribution.code',
    ]);
  });

  it('uses a SHARED MKT- code for the first batch only', async () => {
    const { engine, store } = setup();
    const d = issuableDraft();
    const c = await approved(
      engine,
      issuableDraft({
        distribution: { ...d.distribution, codeType: 'SHARED', code: 'MKT-WELCOME' },
      }),
    );
    await engine.issue(maker, { campaignId: c.id, customerIds: ['0551000001'] });
    await engine.issue(maker, { campaignId: c.id, customerIds: ['0551000002'] });
    expect(store.coupons[0]!.row.code).toBe('MKT-WELCOME');
    expect(store.coupons[1]!.row.code).toMatch(/^MKT-[A-Z0-9]{8}$/);
    expect(store.coupons[1]!.row.code).not.toBe('MKT-WELCOME');
  });
});

describe('results', () => {
  it('performance counts what the sender actually gave, per day, beside the approved plan', async () => {
    const { engine, store } = setup();
    const c = await approved(engine);
    await engine.issue(maker, {
      campaignId: c.id,
      customerIds: ['0551000001', '0551000002', '0551000003'],
    });
    store.recipients[0]!.status = 'sent';
    store.recipients[0]!.sent_at = '2026-11-16T10:00:00Z';
    store.recipients[1]!.status = 'sent';
    store.recipients[1]!.sent_at = '2026-11-17T10:00:00Z';
    store.recipients[2]!.status = 'no_account';
    const p = await engine.performance(c.id);
    expect(p).toMatchObject({ campaignId: c.id, issued: 2, redeemed: 0, controlGroup: null });
    expect(p.perDay).toEqual([
      { day: '2026-11-16', issued: 1, redeemed: 0, revenueSar: 0 },
      { day: '2026-11-17', issued: 1, redeemed: 0, revenueSar: 0 },
    ]);
    expect(p.plan).toEqual(c.snapshot);
    expect(await engine.redemptions(c.id)).toEqual([]);
  });

  it('home, liability, gift card and rewards answers keep the sample shapes', async () => {
    const { engine } = setup();
    const c = await approved(engine);
    await engine.setCampaignStatus(maker, c.id, { status: 'live' });
    const w = await engine.saveCampaign(maker, issuableDraft());
    await engine.submitForApproval(maker, w.id, { forecast: forecastFor() });
    const home = await engine.home();
    expect(home.coupons).toEqual({ live: 1, redeemed: 0, discountSar: 0, waitingApproval: 1 });
    expect(home.alerts.map((a) => a.id)).toEqual([`approval-${w.id}`]);
    const l = await engine.liability();
    expect(l.byProduct[0]).toEqual({
      product: 'coupons',
      faceValueSar: 5000,
      atCostSar: 1800,
      count: 1,
    });
    expect(l.totalFaceValueSar).toBe(5000);
    const g = await engine.giftCardStats({ from: '2026-11-01', to: '2026-11-03' });
    expect(g.perDay.map((x) => x.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect((await engine.rewardsStats()).perMonth.map((m) => m.month)).toEqual([
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
    ]);
    expect(await engine.giftCardActivity()).toEqual([]);
    expect(await engine.rewardsMembers()).toEqual([]);
    expect(await engine.ordersExport()).toEqual([]);
  });

  it('the catalogue: the coupon brands with Yiji ids, the CRM stores as branches', async () => {
    const { engine, store } = setup();
    store.stores = [
      { id: 's1', name: 'Olaya', city: 'Riyadh', brandName: 'Okashi' },
      { id: 's2', name: 'Nowhere', city: null, brandName: null },
    ];
    const cat = await engine.catalogue();
    expect(cat.brands.map((b) => b.id)).toEqual(['1', '3', '81', '1004']);
    expect(cat.branches).toEqual([
      { id: 's1', brandId: '3', name: 'Olaya', city: 'Riyadh' },
      { id: 's2', brandId: '', name: 'Nowhere', city: '' },
    ]);
  });

  it('simulates checkout with the shared rules', async () => {
    const { engine } = setup();
    const c = await approved(engine);
    const sim = await engine.simulateCheckout({
      campaignId: c.id,
      brandId: '1',
      orderType: 'DELIVERY',
      subtotalSar: 40,
      otherOffer: false,
      otherCoupon: false,
      loyalty: false,
    });
    expect(sim).toMatchObject({ allowed: false, reason: 'min_order' });
  });
});

describe('gift cards and earning rules', () => {
  const product = {
    name: { en: 'Gift card SAR 100', ar: 'بطاقة' },
    valueSar: 100,
    priceSar: 100,
    validityDays: 365,
    design: { background: '#000', accent: '#fff', message: 'Enjoy' },
    active: true,
    canCombineWithCoupons: false,
  };
  it('saves and edits a product; only someone who prepares may', async () => {
    const { engine } = setup();
    expect((await refusal(engine.saveGiftCardProduct(viewer, product))).status).toBe(403);
    const p = await engine.saveGiftCardProduct(maker, product);
    expect(p).toMatchObject({ ...product, id: expect.stringMatching(/^GC-/) });
    const e = await engine.saveGiftCardProduct(maker, { ...product, active: false }, p.id);
    expect(e.active).toBe(false);
    expect(await engine.giftCardProducts()).toEqual([e]);
    expect((await refusal(engine.saveGiftCardProduct(maker, product, 'GC-NOPE'))).status).toBe(404);
    expect(
      (await refusal(engine.saveGiftCardProduct(maker, { ...product, valueSar: 0 }))).status,
    ).toBe(422);
  });
  it('saves an earning rule and refuses one that ends before it starts', async () => {
    const { engine } = setup();
    const rule = {
      name: 'Standard cashback',
      cashbackPct: { DELIVERY: 5, PICKUP: 8, CARHOP: 10, DINE_IN: 5 },
      brandIds: [],
      active: true,
      validFrom: '2026-01-01',
      validTo: null,
    };
    const r = await engine.saveEarningRule(maker, rule);
    expect(r).toEqual({ ...rule, id: expect.stringMatching(/^ER-/) });
    expect((await engine.saveEarningRule(maker, { ...rule, active: false }, r.id)).active).toBe(
      false,
    );
    expect(
      (await refusal(engine.saveEarningRule(maker, { ...rule, validTo: '2025-01-01' }))).code,
    ).toBe('invalid_earning_rule');
    expect((await refusal(engine.saveEarningRule(maker, rule, 'ER-x'))).status).toBe(404);
    expect((await refusal(engine.saveEarningRule(checker, rule))).status).toBe(403);
  });
});

describe('pre-studies: stamped by the server, four eyes on approval', () => {
  const study = (over: Partial<Study> = {}): Study => ({
    id: 'STU-2611-0009',
    name: 'Okashi lunch push',
    stage: 'draft',
    objective: 'SLOW_HOURS',
    createdBy: 'someone-else',
    createdAt: '2020-01-01T00:00:00Z',
    period: { from: '2026-05-01', to: '2026-11-01' },
    data: {
      rowsRead: 0,
      completedOrders: 0,
      notCompleted: 0,
      brands: 0,
      cities: 0,
      customers: 0,
      revenueSar: 0,
    },
    scenarios: [
      {
        id: 's1',
        label: 'Cautious',
        draft: issuableDraft(),
        input: { customersMatched: 2400, redemptionRatePct: 20, avgOrderSar: 67 },
        forecast: forecastFor() as never,
      },
    ],
    chosenScenarioId: null,
    review: { by: null, at: null, note: null },
    approval: {
      requestedBy: null,
      requestedAt: null,
      decidedBy: 'forged',
      decidedAt: null,
      note: null,
    },
    campaignId: null,
    ...over,
  });

  it('walks the whole life of a study', async () => {
    const { engine, store } = setup();
    const s0 = await engine.saveStudy(maker, study(), 'STU-2611-0009');
    expect(s0).toMatchObject({
      createdBy: 'user-maker',
      stage: 'draft',
      approval: { decidedBy: null },
    });
    const s1 = await engine.saveStudy(
      maker,
      { ...s0, stage: 'finance_review', chosenScenarioId: 's1' },
      s0.id,
    );
    expect(s1.approval).toMatchObject({
      requestedBy: 'user-maker',
      requestedAt: NOW.toISOString(),
    });
    expect(
      (await refusal(engine.saveStudy(maker, { ...s1, stage: 'waiting_approval' }, s0.id))).status,
    ).toBe(403);
    const s2 = await engine.saveStudy(
      checker,
      { ...s1, stage: 'waiting_approval', review: { by: 'forged', at: 'x', note: 'checked' } },
      s0.id,
    );
    expect(s2.review).toEqual({ by: 'user-checker', at: NOW.toISOString(), note: 'checked' });
    /* The submitted scenarios are what gets approved. */
    const s3 = await engine.saveStudy(
      checker,
      { ...s2, stage: 'approved', scenarios: [], approval: { ...s2.approval, note: 'go' } },
      s0.id,
    );
    expect(s3.scenarios).toHaveLength(1);
    expect(s3.approval).toMatchObject({ decidedBy: 'user-checker', note: 'go' });
    expect(
      (
        await refusal(
          engine.saveStudy(maker, { ...s3, stage: 'running', campaignId: 'CMP-none' }, s0.id),
        )
      ).code,
    ).toBe('invalid_study');
    const c = await engine.saveCampaign(maker, { ...issuableDraft(), studyId: s0.id });
    const s4 = await engine.saveStudy(maker, { ...s3, stage: 'running', campaignId: c.id }, s0.id);
    expect(s4.campaignId).toBe(c.id);
    const s5 = await engine.saveStudy(maker, { ...s4, stage: 'finished' }, s0.id);
    expect(s5.stage).toBe('finished');
    expect((await refusal(engine.saveStudy(maker, { ...s5, stage: 'draft' }, s0.id))).status).toBe(
      409,
    );
    expect(store.activity.map((a) => a.action)).toContain('launched');
    expect((await engine.listStudies()).map((s) => s.id)).toEqual([s0.id]);
  });

  it('the creator never approves their own study', async () => {
    const { engine } = setup();
    const both = { ...maker, privileges: { ...maker.privileges, approve_marketing: true } };
    const s0 = await engine.saveStudy(both, study(), 'STU-2611-0009');
    await engine.saveStudy(both, { ...s0, stage: 'finance_review', chosenScenarioId: 's1' }, s0.id);
    const s2 = await engine.saveStudy(both, { ...s0, stage: 'waiting_approval' }, s0.id);
    expect((await refusal(engine.saveStudy(both, { ...s2, stage: 'approved' }, s0.id))).code).toBe(
      'own_study',
    );
    const back = await engine.saveStudy(checker, { ...s2, stage: 'draft' }, s0.id);
    expect(back.approval).toMatchObject({ decidedBy: 'user-checker', note: 'sent back' });
  });

  it('refuses a study without a chosen scenario, a mismatched id, or bad shape', async () => {
    const { engine } = setup();
    const s0 = await engine.saveStudy(maker, study(), 'STU-2611-0009');
    expect(
      (await refusal(engine.saveStudy(maker, { ...s0, stage: 'finance_review' }, s0.id))).code,
    ).toBe('invalid_study');
    expect((await refusal(engine.saveStudy(maker, s0, 'STU-other'))).code).toBe('invalid_study');
    expect(
      (await refusal(engine.saveStudy(maker, { ...s0, stage: 'nope' as never }, s0.id))).status,
    ).toBe(422);
    expect(
      (await refusal(engine.saveStudy(viewer, study({ id: 'STU-new' }), 'STU-new'))).status,
    ).toBe(403);
  });
});

describe('every field of the field specification is persisted and returned', () => {
  /** A draft that sets every one of the spec's paths to a non-default value. */
  const full = issuableDraft({
    objective: 'OCCASION',
    name: { en: 'Birthday gift', ar: 'هدية' },
    reasonCode: 'LATE_ORDER',
    funding: { source: 'SHARED', partnerSharePct: 30 },
    tenantId: 'yiji-2',
    notes: 'Internal note',
    offer: {
      type: 'PERCENT',
      percent: 25,
      amountSar: 7,
      maxDiscountSar: 30,
      bxgy: { buyQty: 2, getQty: 1, productIds: ['P-1'] },
      freeItem: { productId: 'P-2', quantity: 2 },
      bundle: { productIds: ['P-3', 'P-4'], priceSar: 32 },
      deliveryFeeCovered: 5,
      cashback: { creditValidityDays: 21 },
      posDiscountCode: 'POS-9',
      onRefund: 'KEEP',
      onCancelBeforeCompletion: 'NEVER_RETURN',
      partialRedemption: {
        enabled: true,
        maxPerOrderSar: 15,
        balanceExpiry: 'DAYS_30',
        onOrderCancel: 'KEEP',
      },
    },
    experiment: {
      enabled: true,
      variantB: { value: 12 },
      splitPctA: 40,
      winnerMetric: 'REVENUE',
      autoWinnerAfterDays: 5,
    },
    trigger: {
      birthday: {
        occasion: 'REGISTRATION_ANNIVERSARY',
        issueDaysBefore: 5,
        missingDateOfBirth: 'SKIP',
        tierBoost: { enabled: false, extraSar: 15 },
      },
    },
    loyalty: {
      stampsRequired: 6,
      reward: 'Free pasta',
      stampExpiryDays: 90,
      milestones: ['5', '10'],
      minOrderToCountSar: 35,
      countOrdersFrom: 'THIS_BRAND',
      repeat: false,
      progressMessages: false,
    },
    audience: {
      mode: 'PHONES',
      conditions: [{ c: 'TIER', p: 'GOLD' }],
      match: 'ANY',
      phoneNumbers: ['+966551234567'],
      listId: 'list-9',
      visibility: 'PUBLIC',
      controlGroupPct: 15,
      excludeDiscountSensitive: false,
    },
    rules: {
      minOrderSar: 45,
      maxOrderSar: 300,
      previousOrders: 'THREE_PLUS',
      firstOrderOnly: true,
      paymentMethods: ['MADA', 'CARD'],
    },
    scope: {
      brandIds: ['3'],
      branchIds: ['b-1'],
      categoryIds: ['c-1'],
      productIds: ['P-5'],
      excludedProductIds: ['P-6'],
      orderTypes: ['PICKUP', 'DINE_IN'],
    },
    limits: {
      perCustomerMode: 'MONTHLY',
      perCustomerMax: 4,
      totalRedemptions: 1200,
      dailyRedemptions: 50,
      budgetSar: 15000,
    },
    distribution: {
      codeType: 'UNIQUE',
      code: 'BDAY',
      uniqueCodeCount: 5000,
      channels: ['SMS', 'EMAIL'],
    },
    stacking: {
      combineWithOtherOffers: true,
      combineWithLoyalty: false,
      combineWithOtherCoupons: true,
    },
    validity: {
      startDate: '2026-12-01',
      endDate: '2026-12-31',
      startTime: '10:00',
      endTime: '22:00',
      daysOfWeek: [5, 6],
    },
  });

  /** `campaign.name.en` -> `name.en`; `audience.conditions[]` -> `audience.conditions`. */
  const draftPath = (p: string) => p.replace(/^campaign\./, '').replace(/\[\]$/, '');

  it('round-trips all 83 spec paths through the Directus row and back', async () => {
    const { engine, store } = setup();
    const saved = await engine.saveCampaign(maker, full);
    await engine.submitForApproval(maker, saved.id, { forecast: forecastFor() });
    const back = (await engine.getCampaign(saved.id))!;
    const missing: string[] = [];
    for (const f of CAMPAIGN_FIELD_SPEC) {
      if (f.path === 'review.snapshot') {
        if (!back.snapshot) missing.push(f.path);
        continue;
      }
      const p = draftPath(f.path);
      const want = valueAtPath(full, p);
      if (want === undefined) missing.push(`${f.path} (not set by the test)`);
      else if (JSON.stringify(valueAtPath(back, p)) !== JSON.stringify(want)) missing.push(f.path);
    }
    expect(missing).toEqual([]);
    expect(CAMPAIGN_FIELD_SPEC).toHaveLength(83);
    /* ...and the typed columns a list or filter reads. */
    expect(store.campaigns[0]!.row).toMatchObject({
      engine_code: saved.id,
      engine_status: 'waiting_approval',
      objective: 'OCCASION',
      offer_type: 'PERCENT',
      tenant_id: 'yiji-2',
      prepared_by: 'user-maker',
      name: 'Birthday gift',
      name_ar: 'هدية',
      start_date: '2026-12-01',
      end_date: '2026-12-31',
      budget: 15000,
      status: 'active',
    });
    /* The study it came from, too. */
    const withStudy = await engine.saveCampaign(maker, { ...full, studyId: 'STU-1' });
    expect((await engine.getCampaign(withStudy.id))!.studyId).toBe('STU-1');
  });
});
