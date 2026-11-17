import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_FIELD_SPEC,
  CampaignDraft,
  campaignDraftIssues,
  objectiveSpec,
} from '@yiji/shared-types';
import en from '../src/i18n/en.json';
import ar from '../src/i18n/ar.json';
import { fieldForIssue, stepProblems } from '../src/features/promo/CampaignWizard.js';
import { CampaignDraftFromSpec, scheduleFor } from '../src/engine/sample.js';

/* FIELD PARITY IN THE FORM (owner, 2026-11-17): every one of the design's
   107 fields is on the campaign form, on the design's step, labelled in
   English and Arabic - and a broken rule shows on the step it belongs to. */

/* jsdom gives import.meta.url an http scheme: read from the package root (vitest's cwd). */
const WIZARD = readFileSync(
  resolve(process.cwd(), 'src/features/promo/CampaignWizard.tsx'),
  'utf8',
);
const fieldsEn = (en as { promo: { field: Record<string, string>; rule: Record<string, string> } })
  .promo;
const fieldsAr = (ar as { promo: { field: Record<string, string>; rule: Record<string, string> } })
  .promo;

/** The source of the `{step === n && (...)}` block of the wizard. */
function stepSource(n: number): string {
  const start = WIZARD.indexOf(`{step === ${n} && (`);
  const end =
    n < 7 ? WIZARD.indexOf(`{step === ${n + 1} && (`) : WIZARD.indexOf('mt-5 flex items-center');
  expect(start).toBeGreaterThan(0);
  return WIZARD.slice(start, end);
}

const t = (_k: string, o: { defaultValue: string }) => o.defaultValue;

describe('every design field is on the form, on its step, in both languages', () => {
  it.each(CAMPAIGN_FIELD_SPEC.map((f) => [f.path, f] as const))('%s', (_, f) => {
    expect(fieldsEn.field[f.key]).toBe(f.label);
    expect(fieldsAr.field[f.key]?.trim()).toBeTruthy();
    expect(fieldsAr.field[f.key]).not.toBe(f.label);
    /* the label is rendered with its key, on the design's step */
    expect(stepSource(f.step)).toContain(`t('promo.field.${f.key}'`);
  });

  it('has a translation, in both languages, for every rule the schema can name', () => {
    const d = CampaignDraft.parse({
      objective: 'REPEAT_PURCHASE',
      name: { en: 'x', ar: 'y' },
      offer: { type: 'FIXED', amountSar: 5 },
      audience: { mode: 'ALL' },
      limits: { totalRedemptions: 1, budgetSar: 1 },
      distribution: { channels: ['APP_WALLET'] },
      schedule: { startDate: '2026-11-16', endDate: '2026-11-20', expiresAfterIssueDays: 3 },
    });
    /* break everything at once: every rule id the function can return */
    const broken = {
      ...d,
      objective: 'FIRST_ORDER' as const,
      funding: { source: 'PARTNER' as const, partnerSharePct: 0 },
      offer: {
        ...d.offer,
        type: 'PERCENT' as const,
        amountSar: undefined,
        partialRedemption: {
          enabled: true,
          balanceExpiry: 'SAME' as const,
          onOrderCancel: 'RESTORE' as const,
        },
      },
      experiment: { ...d.experiment, enabled: true },
      trigger: {
        birthday: {
          occasion: 'BIRTHDAY' as const,
          issueDaysBefore: 3,
          missingDateOfBirth: 'ASK' as const,
          tierBoost: { enabled: true, extraSar: 0 },
        },
      },
      loyalty: {
        type: 'CHALLENGE' as const,
        stampExpiryDays: 60,
        milestones: [],
        minOrderToCountSar: 0,
        countOrdersFrom: 'ANY' as const,
        repeat: true,
        progressMessages: true,
      },
      audience: { ...d.audience, mode: 'SEGMENT' as const },
      rules: { ...d.rules, binRanges: ['499999-400000'] },
      scope: { ...d.scope, allBrands: false },
      limits: { ...d.limits, perCustomerMode: 'MONTHLY' as const },
      distribution: {
        ...d.distribution,
        codeType: 'SHARED' as const,
        channels: ['PUSH' as const, 'SMS' as const],
      },
      schedule: {
        ...d.schedule,
        endDate: '2026-11-01',
        allDay: false,
        timeWindow: { from: '10:00' },
        limitedTime: { enabled: true },
      },
      communication: { ...d.communication, respectConsent: false },
    };
    const rules = new Set(campaignDraftIssues(broken).map((i) => i.rule));
    expect(rules.size).toBeGreaterThanOrEqual(20);
    /* ...and every rule id written in the schema's source, reachable or not here */
    const src = readFileSync(
      resolve(process.cwd(), '../../packages/shared-types/src/marketing-engine.ts'),
      'utf8',
    );
    const body = src.slice(src.indexOf('export function campaignDraftIssues'));
    for (const m of body
      .slice(0, body.indexOf('\n}\n'))
      .matchAll(/add\(\s*(?:'[^']*'|`[^`]*`),\s*'(\w+)'/g))
      rules.add(m[1]!);
    expect(rules.size).toBe(35);
    for (const r of rules) {
      expect(fieldsEn.rule[r], r).toBeTruthy();
      expect(fieldsAr.rule[r], r).toBeTruthy();
    }
  });
});

describe('the problems show on the step the field is on', () => {
  const base = () =>
    CampaignDraftFromSpec(objectiveSpec('REPEAT_PURCHASE'), {
      name: { en: 'Second order', ar: 'الطلب الثاني' },
      schedule: scheduleFor('2026-11-16', 14),
      communication: {
        push: { title: { en: 'Hi', ar: 'مرحبا' }, body: { en: 'Hi', ar: 'مرحبا' } },
        banner: { text: { en: '', ar: '' } },
        sms: { text: { en: '', ar: '' } },
        sendTime: 'ON_ISSUE',
        frequencyCap: 'THREE_PER_WEEK',
        quietHours: true,
        respectConsent: true,
      },
    });

  it('a complete draft has none', () => {
    expect(stepProblems(base(), [], t)).toEqual([[], [], [], [], [], [], []]);
  });

  it('maps an issue path to its design field, nested and indexed paths included', () => {
    expect(fieldForIssue('audience.phoneNumbers.0')?.path).toBe('audience.phoneNumbers[]');
    expect(fieldForIssue('name.en')?.path).toBe('campaign.name.en');
    expect(fieldForIssue('schedule.timeWindow.to')?.step).toBe(5);
    expect(fieldForIssue('rules.minOrderSar')?.step).toBe(2);
    expect(fieldForIssue('distribution.code')?.step).toBe(4);
  });

  it("puts each broken rule on its step, with the field's label", () => {
    const d = base();
    const p = stepProblems(
      {
        ...d,
        name: { en: '', ar: 'x' },
        offer: { ...d.offer, amountSar: undefined },
        audience: { ...d.audience, mode: 'PHONES', phoneNumbers: [] },
        scope: { ...d.scope, allBrands: false, brandIds: [] },
        schedule: { ...d.schedule, limitedTime: { enabled: true } },
        distribution: { ...d.distribution, channels: ['SMS'] },
        forecast: { baselineOrderRatePct: 300 },
      },
      [],
      t,
    );
    expect(p[0]!.join()).toMatch(/Campaign name \(English\)/);
    expect(p[1]!.join()).toMatch(/Discount amount/);
    expect(p[2]!.join()).toMatch(/Customer phone numbers/);
    expect(p[3]!.join()).toMatch(/Brands/);
    expect(p[4]!.join()).toMatch(/Must be used within/);
    expect(p[5]!.join()).toMatch(/SMS text \(English\).*SMS text \(Arabic\)/);
    expect(p[6]!.join()).toMatch(/Customers who would order anyway/);
  });

  it('checks the bundle price against the menu', () => {
    const d = base();
    const bundle = {
      ...d,
      offer: {
        ...d.offer,
        type: 'BUNDLE' as const,
        bundle: { productIds: ['a', 'b'], priceSar: 50 },
      },
    };
    const menu = [
      { id: 'a', priceSar: 20 },
      { id: 'b', priceSar: 20 },
    ];
    expect(stepProblems(bundle, menu, t)[1]).toEqual([
      'Bundle price: Must be below the items’ normal total.',
    ]);
  });
});
