import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_CODE_ONLY_FIELDS,
  CAMPAIGN_FIELD_RENAMES,
  CAMPAIGN_FIELD_SPEC,
  CampaignDraft,
  StoredCampaignDraft,
  bundlePriceProblem,
  campaignDraftIssues,
  campaignUniquenessConflicts,
  forecastCampaign,
  readCampaignDraft,
  upgradeCampaignDraft,
  wouldOrderAnywayPct,
  type Campaign,
} from '../src/marketing-engine.js';

/* FIELD PARITY (owner, 2026-11-17): the campaign form matches the approved
   design field by field. The design's list is the CSV; these tests pin the
   spec to it row by row and exercise every required / conditional rule. */

const CSV = fileURLToPath(
  new URL('../../../docs/marketing/ayman-draft-fields.csv', import.meta.url),
);
const rows = readFileSync(CSV, 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test drafts are built loosely, then validated
type Loose = Record<string, any>;

/** A draft that passes every rule: the base the cases below break one at a time. */
const ok = () =>
  ({
    objective: 'REPEAT_PURCHASE',
    name: { en: 'Second order', ar: 'الطلب الثاني' },
    offer: { type: 'FIXED', amountSar: 7 },
    audience: { mode: 'ALL' },
    limits: { totalRedemptions: 1000, budgetSar: 5000 },
    distribution: { channels: ['APP_WALLET'] },
    schedule: { startDate: '2026-11-16', endDate: '2026-12-16', expiresAfterIssueDays: 7 },
  }) as Loose;

/** The paths the schema refuses `d` on (empty = valid). */
const refused = (d: unknown): string[] => {
  const r = CampaignDraft.safeParse(d);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('the field specification is the design, row by row', () => {
  it("has the CSV's 107 rows, in its order, with its step, label, path, type, required and notes", () => {
    expect(rows).toHaveLength(107);
    expect(CAMPAIGN_FIELD_SPEC).toHaveLength(rows.length);
    CAMPAIGN_FIELD_SPEC.forEach((f, i) => {
      const [step, label, path, type, required, notes] = rows[i]!;
      expect({
        step: f.step,
        label: f.label,
        path: f.path,
        type: f.type,
        required: f.required,
        notes: f.notes,
      }).toEqual({
        step: Number(step),
        label,
        path,
        type,
        required,
        notes,
      });
    });
  });

  it('gives every row an i18n key derived from its path', () => {
    for (const f of CAMPAIGN_FIELD_SPEC)
      expect(f.key).toBe(
        f.path
          .replace(/^campaign\./, '')
          .replace(/\[\]/g, '')
          .replace(/\./g, '_'),
      );
    expect(new Set(CAMPAIGN_FIELD_SPEC.map((f) => f.key)).size).toBe(107);
  });

  it('every renamed path lands on a design path, and no code-only field is in the design', () => {
    const paths = new Set(CAMPAIGN_FIELD_SPEC.map((f) => f.path));
    for (const to of Object.values(CAMPAIGN_FIELD_RENAMES)) expect(paths.has(to)).toBe(true);
    for (const f of CAMPAIGN_CODE_ONLY_FIELDS) expect(paths.has(f.path)).toBe(false);
  });
});

describe("the design's rules, one at a time", () => {
  it('accepts the base draft', () => {
    expect(refused(ok())).toEqual([]);
  });

  const cases: Array<[string, (d: Loose) => void, string[]]> = [
    ['name over 60 characters', (d) => (d.name = { en: 'x'.repeat(61), ar: 'y' }), ['name.en']],
    ['no Arabic name', (d) => (d.name = { en: 'x', ar: ' ' }), ['name.ar']],
    ['compensation without a reason', (d) => (d.objective = 'SERVICE_RECOVERY'), ['reasonCode']],
    [
      'a partner funds it but pays nothing',
      (d) => (d.funding = { source: 'PARTNER' }),
      ['funding.partnerSharePct'],
    ],
    [
      'percent outside 1-100',
      (d) => (d.offer = { type: 'PERCENT', percent: 0, maxDiscountSar: 5 }),
      ['offer.percent'],
    ],
    [
      'percent above 100',
      (d) => (d.offer = { type: 'PERCENT', percent: 101, maxDiscountSar: 5 }),
      ['offer.percent'],
    ],
    [
      'a percentage without its maximum',
      (d) => (d.offer = { type: 'PERCENT', percent: 20 }),
      ['offer.maxDiscountSar'],
    ],
    [
      'cashback without its maximum',
      (d) => (d.offer = { type: 'CASHBACK', percent: 5 }),
      ['offer.maxDiscountSar'],
    ],
    [
      'a fixed amount of 0',
      (d) => (d.offer = { type: 'FIXED', amountSar: 0 }),
      ['offer.amountSar'],
    ],
    [
      'a fixed discount without an amount',
      (d) => (d.offer = { type: 'FIXED' }),
      ['offer.amountSar'],
    ],
    [
      'BXGY without the item',
      (d) => (d.offer = { type: 'BXGY', bxgy: { buyQty: 1, getQty: 1, productId: '' } }),
      ['offer.bxgy.productId'],
    ],
    [
      'a free item not picked',
      (d) => (d.offer = { type: 'FREE_ITEM' }),
      ['offer.freeItem.productId'],
    ],
    [
      'a bundle of one item',
      (d) => (d.offer = { type: 'BUNDLE', bundle: { productIds: ['a'], priceSar: 9 } }),
      ['offer.bundle.productIds'],
    ],
    ['a bundle not set', (d) => (d.offer = { type: 'BUNDLE' }), ['offer.bundle.productIds']],
    [
      'partial redemption on a percentage',
      (d) =>
        (d.offer = {
          type: 'PERCENT',
          percent: 10,
          maxDiscountSar: 5,
          partialRedemption: { enabled: true },
        }),
      ['offer.partialRedemption.enabled'],
    ],
    [
      'a test on free delivery',
      (d) => (
        (d.offer = { type: 'FREE_DELIVERY' }),
        (d.experiment = { enabled: true, variantB: { value: 5 } })
      ),
      ['experiment.enabled'],
    ],
    [
      'a test without version B',
      (d) => (d.experiment = { enabled: true }),
      ['experiment.variantB.value'],
    ],
    [
      'version B above 100% on a percentage',
      (d) => (
        (d.offer = { type: 'PERCENT', percent: 10, maxDiscountSar: 5 }),
        (d.experiment = { enabled: true, variantB: { value: 120 } })
      ),
      ['experiment.variantB.value'],
    ],
    ['a split outside 10-90', (d) => (d.experiment = { splitPctA: 95 }), ['experiment.splitPctA']],
    [
      'a bigger gift of 0',
      (d) => (d.trigger = { birthday: { tierBoost: { enabled: true, extraSar: 0 } } }),
      ['trigger.birthday.tierBoost.extraSar'],
    ],
    [
      'a stamp card with no loyalty set-up',
      (d) => (d.objective = 'FREQUENT_ORDER'),
      ['loyalty.type'],
    ],
    [
      'a stamp card without its orders',
      (d) => (d.loyalty = { type: 'STAMP' }),
      ['loyalty.ordersRequired'],
    ],
    [
      'a challenge without its window',
      (d) => (d.loyalty = { type: 'CHALLENGE', ordersRequired: 3 }),
      ['loyalty.windowDays'],
    ],
    [
      'milestones without a number',
      (d) => (d.loyalty = { type: 'MILESTONE' }),
      ['loyalty.milestones'],
    ],
    [
      'a segment without conditions',
      (d) => (d.audience = { mode: 'SEGMENT' }),
      ['audience.conditions'],
    ],
    [
      'phone numbers without numbers',
      (d) => (d.audience = { mode: 'PHONES' }),
      ['audience.phoneNumbers'],
    ],
    [
      'a phone number that is not Saudi mobile',
      (d) => (d.audience = { mode: 'PHONES', phoneNumbers: ['0551234567'] }),
      ['audience.phoneNumbers.0'],
    ],
    [
      'a measurement group above 20%',
      (d) => (d.audience = { mode: 'ALL', controlGroupPct: 25 }),
      ['audience.controlGroupPct'],
    ],
    ['no payment method', (d) => (d.rules = { paymentMethods: [] }), ['rules.paymentMethods']],
    [
      'a malformed bank card range',
      (d) => (d.rules = { binRanges: ['4000'] }),
      ['rules.binRanges.0'],
    ],
    [
      'a bank card range high to low',
      (d) => (d.rules = { binRanges: ['499999-400000'] }),
      ['rules.binRanges.0'],
    ],
    [
      'a bank card range of mixed lengths',
      (d) => (d.rules = { binRanges: ['400000-4999999'] }),
      ['rules.binRanges.0'],
    ],
    [
      'brands listed while "all brands" is on',
      (d) => (d.scope = { allBrands: true, brandIds: ['3'] }),
      ['scope.allBrands'],
    ],
    ['"all brands" off and no brand', (d) => (d.scope = { allBrands: false }), ['scope.brandIds']],
    ['no order type', (d) => (d.scope = { orderTypes: [] }), ['scope.orderTypes']],
    [
      'a monthly limit without its maximum',
      (d) => (d.limits = { ...d.limits, perCustomerMode: 'MONTHLY' }),
      ['limits.perCustomerMax'],
    ],
    [
      'no total redemption limit',
      (d) => (d.limits = { budgetSar: 10 }),
      ['limits.totalRedemptions'],
    ],
    ['no budget', (d) => (d.limits = { totalRedemptions: 10 }), ['limits.budgetSar']],
    [
      'a shared code left empty',
      (d) => (d.distribution = { channels: ['APP_WALLET'], codeType: 'SHARED' }),
      ['distribution.code'],
    ],
    [
      'unique codes without a count',
      (d) => (d.distribution = { channels: ['APP_WALLET'], codeType: 'UNIQUE' }),
      ['distribution.uniqueCodeCount'],
    ],
    [
      'a first-order coupon without one-per-phone-and-device',
      (d) => (d.objective = 'FIRST_ORDER'),
      ['fraud.onePerPhoneAndDevice'],
    ],
    [
      'a new-customer coupon without it either',
      (d) => (d.objective = 'NEW_CUSTOMER'),
      ['fraud.onePerPhoneAndDevice'],
    ],
    [
      '"first order only" without it',
      (d) => (d.rules = { firstOrderOnly: true }),
      ['fraud.onePerPhoneAndDevice'],
    ],
    [
      'an end before the start',
      (d) => (d.schedule = { ...d.schedule, endDate: '2026-11-01' }),
      ['schedule.endDate'],
    ],
    [
      'all day and a time window',
      (d) => (d.schedule = { ...d.schedule, timeWindow: { from: '10:00', to: '12:00' } }),
      ['schedule.allDay'],
    ],
    [
      'not all day and no times',
      (d) => (d.schedule = { ...d.schedule, allDay: false }),
      ['schedule.timeWindow.from'],
    ],
    [
      'only a start time',
      (d) => (d.schedule = { ...d.schedule, allDay: false, timeWindow: { from: '10:00' } }),
      ['schedule.timeWindow.from', 'schedule.timeWindow.to'],
    ],
    [
      'the same start and end time',
      (d) =>
        (d.schedule = { ...d.schedule, allDay: false, timeWindow: { from: '10:00', to: '10:00' } }),
      ['schedule.timeWindow.to'],
    ],
    [
      'a time that is not hh:mm',
      (d) =>
        (d.schedule = { ...d.schedule, allDay: false, timeWindow: { from: '25:00', to: '10:00' } }),
      ['schedule.timeWindow.from'],
    ],
    [
      'no day of the week',
      (d) => (d.schedule = { ...d.schedule, daysOfWeek: [] }),
      ['schedule.daysOfWeek'],
    ],
    [
      'no expiry after issue',
      (d) => (d.schedule = { startDate: '2026-11-16', endDate: '2026-12-16' }),
      ['schedule.expiresAfterIssueDays'],
    ],
    [
      'an expiry of 0 days',
      (d) => (d.schedule = { ...d.schedule, expiresAfterIssueDays: 0 }),
      ['schedule.expiresAfterIssueDays'],
    ],
    [
      'a flash offer without its hours',
      (d) => (d.schedule = { ...d.schedule, limitedTime: { enabled: true } }),
      ['schedule.limitedTime.hours'],
    ],
    [
      'a flash offer over a week',
      (d) => (d.schedule = { ...d.schedule, limitedTime: { enabled: true, hours: 169 } }),
      ['schedule.limitedTime.hours'],
    ],
    ['no channel', (d) => (d.distribution = { channels: [] }), ['distribution.channels']],
    [
      'push without its copy',
      (d) => (d.distribution = { channels: ['PUSH'] }),
      [
        'communication.push.title.en',
        'communication.push.title.ar',
        'communication.push.body.en',
        'communication.push.body.ar',
      ],
    ],
    [
      'a banner without its headline',
      (d) => (d.distribution = { channels: ['IN_APP_BANNER'] }),
      ['communication.banner.text.en', 'communication.banner.text.ar'],
    ],
    [
      'SMS without its text',
      (d) => (
        (d.distribution = { channels: ['SMS'] }),
        (d.communication = { sms: { text: { en: 'Hi' } } })
      ),
      ['communication.sms.text.ar'],
    ],
    [
      'SMS with consent switched off (PDPL)',
      (d) => (
        (d.distribution = { channels: ['SMS'] }),
        (d.communication = { sms: { text: { en: 'Hi', ar: 'مرحبا' } }, respectConsent: false })
      ),
      ['communication.respectConsent'],
    ],
    [
      'email with consent switched off (PDPL)',
      (d) => (
        (d.distribution = { channels: ['EMAIL'] }),
        (d.communication = { respectConsent: false })
      ),
      ['communication.respectConsent'],
    ],
    [
      'a push title over 65 characters',
      (d) => (d.communication = { push: { title: { en: 'x'.repeat(66) } } }),
      ['communication.push.title.en'],
    ],
    [
      'an unknown frequency cap',
      (d) => (d.communication = { frequencyCap: 'TEN_PER_DAY' }),
      ['communication.frequencyCap'],
    ],
    [
      'a baseline above 100%',
      (d) => (d.forecast = { baselineOrderRatePct: 120 }),
      ['forecast.baselineOrderRatePct'],
    ],
    [
      'an uplift below 0',
      (d) => (d.forecast = { expectedUpliftPts: -1 }),
      ['forecast.expectedUpliftPts'],
    ],
  ];

  it.each(cases)('refuses %s', (_, breakIt, paths) => {
    const d = ok();
    breakIt(d);
    expect(refused(d).sort()).toEqual([...paths].sort());
  });

  it('accepts each conditional field once its condition is met', () => {
    const pass: Array<(d: Loose) => void> = [
      (d) => ((d.objective = 'SERVICE_RECOVERY'), (d.reasonCode = 'LATE_ORDER')),
      (d) => (d.funding = { source: 'SHARED', partnerSharePct: 40 }),
      (d) =>
        (d.offer = {
          type: 'CASHBACK',
          percent: 5,
          maxDiscountSar: 10,
          cashback: { creditValidityDays: 30 },
        }),
      (d) => (d.offer = { type: 'BXGY', bxgy: { buyQty: 2, getQty: 1, productId: 'P1' } }),
      (d) => (d.offer = { type: 'FREE_ITEM', freeItem: { productId: 'P1' } }),
      (d) => (d.offer = { type: 'BUNDLE', bundle: { productIds: ['a', 'b'], priceSar: 30 } }),
      (d) => (d.offer = { type: 'FREE_DELIVERY', deliveryFeeCoveredSar: 'FULL' }),
      (d) =>
        (d.offer = {
          type: 'FIXED',
          amountSar: 20,
          partialRedemption: { enabled: true, maxPerOrderSar: 5 },
        }),
      (d) => (d.experiment = { enabled: true, variantB: { value: 9 }, splitPctA: 10 }),
      (d) => ((d.objective = 'FREQUENT_ORDER'), (d.loyalty = { type: 'STAMP', ordersRequired: 5 })),
      (d) => (d.loyalty = { type: 'CHALLENGE', ordersRequired: 3, windowDays: 14 }),
      (d) => (d.loyalty = { type: 'MILESTONE', milestones: ['10', '25'] }),
      (d) => (d.audience = { mode: 'SEGMENT', conditions: [{ c: 'TIER', p: 'GOLD' }] }),
      (d) => (d.audience = { mode: 'PHONES', phoneNumbers: ['+966551234567'] }),
      (d) => (d.rules = { binRanges: ['400000-499999', '52345678'] }),
      (d) => (d.scope = { allBrands: false, brandIds: ['3'] }),
      (d) => (d.limits = { ...d.limits, perCustomerMode: 'MONTHLY', perCustomerMax: 2 }),
      (d) => (d.distribution = { channels: ['APP_WALLET'], codeType: 'SHARED', code: 'MKT-HELLO' }),
      (d) =>
        (d.distribution = { channels: ['APP_WALLET'], codeType: 'UNIQUE', uniqueCodeCount: 500 }),
      (d) => ((d.objective = 'FIRST_ORDER'), (d.fraud = { onePerPhoneAndDevice: true })),
      (d) =>
        (d.schedule = { ...d.schedule, allDay: false, timeWindow: { from: '14:00', to: '17:00' } }),
      (d) => (d.schedule = { ...d.schedule, allDay: false, onlyDuringBranchHours: true }),
      (d) => (d.schedule = { ...d.schedule, limitedTime: { enabled: true, hours: 24 } }),
      (d) => (
        (d.distribution = { channels: ['PUSH', 'IN_APP_BANNER', 'SMS'] }),
        (d.communication = {
          push: { title: { en: 'T', ar: 'ع' }, body: { en: 'B', ar: 'ن' } },
          banner: { text: { en: 'H', ar: 'ع' } },
          sms: { text: { en: 'S', ar: 'ر' } },
        })
      ),
      (d) => (
        (d.distribution = { channels: ['WHATSAPP'] }),
        (d.communication = { respectConsent: false })
      ),
      (d) => (d.forecast = { baselineOrderRatePct: 30, expectedUpliftPts: 6 }),
    ];
    for (const f of pass) {
      const d = ok();
      f(d);
      expect(refused(d)).toEqual([]);
    }
  });

  it('the rules are one pure function the engines share', () => {
    const d = CampaignDraft.parse(ok());
    expect(campaignDraftIssues(d)).toEqual([]);
    expect(campaignDraftIssues({ ...d, audience: { ...d.audience, mode: 'SEGMENT' } })).toEqual([
      {
        path: 'audience.conditions',
        rule: 'conditionsRequired',
        message: 'Add at least one condition.',
      },
    ]);
  });
});

describe('the defaults the design gives', () => {
  it('fills every optional field', () => {
    const d = CampaignDraft.parse(ok());
    expect(d.scope.allBrands).toBe(true);
    expect(d.rules.binRanges).toEqual([]);
    expect(d.fraud).toEqual({
      onePerPhoneAndDevice: false,
      excludeStaffAndTestAccounts: false,
      blockFlaggedCustomers: false,
    });
    expect(d.schedule).toMatchObject({
      allDay: true,
      timeWindow: {},
      onlyDuringBranchHours: false,
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      limitedTime: { enabled: false },
    });
    expect(d.distribution).toMatchObject({ addMode: 'AUTO_WALLET', issueMode: 'ALL_AT_ONCE' });
    expect(d.communication).toEqual({
      push: { title: { en: '', ar: '' }, body: { en: '', ar: '' } },
      banner: { text: { en: '', ar: '' } },
      sms: { text: { en: '', ar: '' } },
      sendTime: 'ON_ISSUE',
      frequencyCap: 'THREE_PER_WEEK',
      quietHours: true,
      respectConsent: true,
    });
    expect(d.forecast).toEqual({});
  });
});

describe('old stored drafts', () => {
  const old = {
    objective: 'SLOW_HOURS',
    name: { en: 'Lunch', ar: 'غداء' },
    offer: {
      type: 'BXGY',
      bxgy: { buyQty: 1, getQty: 1, productIds: ['A', 'B'] },
      deliveryFeeCovered: 5,
    },
    audience: { mode: 'ALL' },
    limits: { totalRedemptions: 10, budgetSar: 100 },
    distribution: { channels: ['APP_WALLET'] },
    loyalty: { milestones: ['5'], reward: 'Cake' },
    notes: 'x',
    validity: {
      startDate: '2026-11-01',
      endDate: '2026-11-10',
      startTime: '12:00',
      endTime: '15:00',
    },
  };

  it('upgrades every renamed path, and is idempotent', () => {
    const up = upgradeCampaignDraft(old) as Loose;
    expect(up.validity).toBeUndefined();
    expect(up.schedule).toEqual({
      startDate: '2026-11-01',
      endDate: '2026-11-10',
      allDay: false,
      timeWindow: { from: '12:00', to: '15:00' },
      expiresAfterIssueDays: 10,
    });
    expect(up.offer.bxgy).toEqual({ buyQty: 1, getQty: 1, productId: 'A' });
    expect(up.offer.deliveryFeeCoveredSar).toBe(5);
    expect(up.offer.deliveryFeeCovered).toBeUndefined();
    expect(up.loyalty).toEqual({ milestones: ['5'], type: 'MILESTONE' });
    expect(up.notes).toBe('x\nLoyalty reward: Cake');
    expect(upgradeCampaignDraft(up)).toEqual(up);
  });

  it('a whole-day old window keeps all day, and a long one caps the expiry at a year', () => {
    const up = upgradeCampaignDraft({
      ...old,
      validity: { startDate: '2026-01-01', endDate: '2027-06-30' },
    }) as Loose;
    expect(up.schedule).toMatchObject({ allDay: true, timeWindow: {}, expiresAfterIssueDays: 365 });
  });

  it('drops a loyalty block that never had a way to earn', () => {
    const up = upgradeCampaignDraft({
      ...old,
      loyalty: { stampExpiryDays: 60, milestones: [] },
    }) as Loose;
    expect(up.loyalty).toBeUndefined();
  });

  it("StoredCampaignDraft takes the old shape and checks it by today's rules", () => {
    const d = StoredCampaignDraft.parse(old);
    expect(d.schedule.timeWindow).toEqual({ from: '12:00', to: '15:00' });
    expect(
      StoredCampaignDraft.safeParse({ ...old, validity: { startDate: 'x', endDate: 'y' } }).success,
    ).toBe(false);
  });

  it('readCampaignDraft never refuses, and leaves anything it does not know alone', () => {
    expect(() => readCampaignDraft(null)).not.toThrow();
    expect(readCampaignDraft('nonsense')).toBeTypeOf('object');
    const broken = readCampaignDraft({ ...old, offer: { type: 'PERCENT', percent: 0 } });
    expect(broken.offer).toMatchObject({
      type: 'PERCENT',
      percent: 0,
      onRefund: 'RETURN_IF_VALID',
    });
    expect(broken.schedule.startDate).toBe('2026-11-01');
    expect(broken.fraud.blockFlaggedCustomers).toBe(false);
  });
});

describe('uniqueness (name, shared code)', () => {
  const d = CampaignDraft.parse(ok());
  const mk = (over: Partial<Campaign>) =>
    ({ ...d, id: 'CMP-1', status: 'live', ...over }) as Campaign;

  it('names a clash on the English name, ignoring case and spaces, but not with itself or an ended one', () => {
    const others = [mk({ name: { en: ' second ORDER ', ar: 'x' } })];
    expect(campaignUniquenessConflicts(d, undefined, others)).toEqual(['campaign.name.en']);
    expect(campaignUniquenessConflicts(d, 'CMP-1', others)).toEqual([]);
    expect(campaignUniquenessConflicts(d, undefined, [mk({ status: 'ended' })])).toEqual([]);
    expect(campaignUniquenessConflicts(d, undefined, [mk({ status: 'rejected' })])).toEqual([]);
  });

  it('names a clash on a shared code only against campaigns that hold or will hold it', () => {
    const shared = { ...d.distribution, codeType: 'SHARED' as const, code: 'MKT-A1B2' };
    const mine = { ...d, name: { en: 'Mine', ar: 'لي' }, distribution: shared };
    expect(campaignUniquenessConflicts(mine, undefined, [mk({ distribution: shared })])).toEqual([
      'distribution.code',
    ]);
    expect(
      campaignUniquenessConflicts(mine, undefined, [mk({ status: 'draft', distribution: shared })]),
    ).toEqual([]);
  });
});

describe('the planning inputs (step 7) feed the business case', () => {
  it('uses the baseline and uplift when both are given, else the money model', () => {
    expect(wouldOrderAnywayPct({})).toBe(25);
    expect(wouldOrderAnywayPct({ baselineOrderRatePct: 30 })).toBe(25);
    expect(wouldOrderAnywayPct({ baselineOrderRatePct: 30, expectedUpliftPts: 10 })).toBe(75);
    const d = CampaignDraft.parse(ok());
    const input = { customersMatched: 1000, redemptionRatePct: 20, avgOrderSar: 60 };
    const plain = forecastCampaign(d, input);
    const planned = forecastCampaign(
      { ...d, forecast: { baselineOrderRatePct: 10, expectedUpliftPts: 40 } },
      input,
    );
    expect(planned.extraProfitSar).toBeGreaterThan(plain.extraProfitSar);
  });
});

describe('a bundle is priced below its items (the menu decides)', () => {
  const menu = [
    { id: 'a', priceSar: 20 },
    { id: 'b', priceSar: 15 },
  ];
  it('refuses a bundle priced at or above the normal total, and passes one below it', () => {
    const bundle = (priceSar: number) => ({
      type: 'BUNDLE' as const,
      bundle: { productIds: ['a', 'b'], priceSar },
    });
    expect(bundlePriceProblem(bundle(35), menu)).toMatch(
      /below the items' normal total \(SAR 35\)/,
    );
    expect(bundlePriceProblem(bundle(40), menu)).not.toBeNull();
    expect(bundlePriceProblem(bundle(30), menu)).toBeNull();
    /* an item the menu does not know: nothing to compare with */
    expect(
      bundlePriceProblem(
        { type: 'BUNDLE', bundle: { productIds: ['a', 'z'], priceSar: 99 } },
        menu,
      ),
    ).toBeNull();
    expect(bundlePriceProblem({ type: 'FIXED' }, menu)).toBeNull();
  });
});
