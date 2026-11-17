import { beforeEach, describe, expect, it } from 'vitest';
import {
  CAMPAIGN_FIELD_SPEC,
  CAMPAIGN_OBJECTIVES,
  CampaignDraftShape,
  forecastCampaign,
  objectiveSpec,
  valueAtPath,
  type Campaign,
} from '@yiji/shared-types';
import {
  CampaignDraftFromSpec,
  SampleMarketingEngine,
  resetSampleEngine,
  scheduleFor,
} from '../src/engine/sample.js';

/* THE SAMPLE ENGINE KEEPS THE ENGINE'S RULES (owner, 2026-11-15): the portal
   runs on it until Yiji v2 answers, so what a user learns here must be what
   the live engine does - the creator never approves, only a campaign waiting
   for approval is decided, and a live campaign's locked fields cannot change. */

let user = 'maha';
const engine = () => new SampleMarketingEngine(() => user);

function draft(name = 'Second order') {
  return CampaignDraftFromSpec(objectiveSpec('REPEAT_PURCHASE'), {
    name: { en: name, ar: name },
    schedule: scheduleFor('2026-11-16', 30),
  });
}

async function waiting(): Promise<Campaign> {
  const e = engine();
  const c = await e.saveCampaign(draft());
  const f = forecastCampaign(c, { customersMatched: 500, redemptionRatePct: 10, avgOrderSar: 90 });
  return e.submitForApproval(c.id, f);
}

describe('the sample engine enforces the approval rules', () => {
  beforeEach(() => {
    resetSampleEngine();
    user = 'maha';
  });

  it('refuses the creator deciding their own campaign', async () => {
    const c = await waiting();
    await expect(engine().decideCampaign(c.id, 'approve', '')).rejects.toThrow(/creator/);
    expect((await engine().getCampaign(c.id))?.status).toBe('waiting_approval');
  });

  it('lets a second person approve, and records who decided', async () => {
    const c = await waiting();
    user = 'nada';
    const approved = await engine().decideCampaign(c.id, 'approve', 'within budget');
    expect(approved.status).toBe('approved');
    expect(approved.approval).toMatchObject({
      requestedBy: 'maha',
      decidedBy: 'nada',
      note: 'within budget',
    });
    expect(approved.snapshot?.customersMatched).toBe(500);
  });

  it('decides only a campaign that is waiting for approval', async () => {
    const e = engine();
    const c = await e.saveCampaign(draft());
    user = 'nada';
    await expect(engine().decideCampaign(c.id, 'reject', 'no')).rejects.toThrow(/not waiting/);
  });
});

describe('the sample engine locks a live campaign', () => {
  beforeEach(() => {
    resetSampleEngine();
    user = 'maha';
  });

  it('refuses a change to the discount or the budget once live; the name stays editable', async () => {
    const c = await waiting();
    user = 'nada';
    await engine().decideCampaign(c.id, 'approve', 'ok');
    await engine().setCampaignStatus(c.id, 'live');

    const cheaper = { ...draft(), offer: { ...draft().offer, percent: 5 } };
    await expect(engine().saveCampaign(cheaper, c.id)).rejects.toThrow(/locked while live: offer/);

    const live = (await engine().getCampaign(c.id))!;
    const biggerBudget = {
      ...live,
      limits: { ...live.limits, budgetSar: live.limits.budgetSar + 1000 },
    };
    /* review 2026-11-16: a live campaign keeps its approval, so its money
       fields are locked too - a bigger budget = a new, approved campaign */
    await expect(engine().saveCampaign(biggerBudget, c.id)).rejects.toThrow(
      /locked while live: limits/,
    );
    const renamed = { ...live, name: { ...live.name, en: 'Renamed' } };
    const saved = await engine().saveCampaign(renamed, c.id);
    expect(saved.name.en).toBe('Renamed');
    expect(saved.status).toBe('live');
  });
});

describe("the sample engine keeps the design's fields", () => {
  beforeEach(() => {
    resetSampleEngine();
    user = 'maha';
  });

  it("every goal's pre-filled draft carries every field the design has, in its shape", () => {
    for (const objective of CAMPAIGN_OBJECTIVES) {
      const d = CampaignDraftFromSpec(objectiveSpec(objective), {
        name: { en: objective, ar: objective },
        schedule: scheduleFor('2026-11-16', 14),
      });
      expect(CampaignDraftShape.safeParse(d).success).toBe(true);
      for (const section of ['fraud', 'communication', 'forecast', 'schedule', 'scope', 'rules'])
        expect(d).toHaveProperty(section);
      expect(d.scope.allBrands).toBe(true);
      expect(d.schedule.expiresAfterIssueDays).toBe(14);
      /* the design: mandatory for first-order and new-customer coupons */
      expect(d.fraud.onePerPhoneAndDevice).toBe(
        objective === 'FIRST_ORDER' || objective === 'NEW_CUSTOMER',
      );
      if (objective === 'FREQUENT_ORDER')
        expect(d.loyalty).toMatchObject({ type: 'STAMP', ordersRequired: 5 });
    }
  });

  it('the seeded campaigns are in the new shape, with every spec section present', async () => {
    const all = await engine().listCampaigns();
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      expect((c as unknown as Record<string, unknown>).validity).toBeUndefined();
      expect(valueAtPath(c, 'schedule.startDate')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const f of CAMPAIGN_FIELD_SPEC.filter((x) => x.required === 'yes'))
        expect(
          valueAtPath(c, f.path.replace(/^campaign\./, '').replace(/\[\]$/, '')),
        ).toBeDefined();
    }
  });

  it('a browser store written before field parity opens in the new shape', async () => {
    const old = {
      campaigns: [
        {
          id: 'CMP-OLD',
          status: 'live',
          createdBy: 'maha',
          createdAt: '2026-11-01T00:00:00Z',
          updatedAt: '2026-11-01T00:00:00Z',
          approval: {},
          snapshot: null,
          changeLog: [],
          objective: 'SLOW_HOURS',
          name: { en: 'Old lunch', ar: 'غداء' },
          offer: { type: 'FREE_DELIVERY', deliveryFeeCovered: 'FULL' },
          audience: { mode: 'ALL' },
          limits: { totalRedemptions: 10, budgetSar: 100 },
          validity: {
            startDate: '2026-11-01',
            endDate: '2026-11-07',
            startTime: '14:00',
            endTime: '17:00',
          },
        },
      ],
      studies: [],
      giftProducts: [],
      earningRules: [],
    };
    localStorage.setItem('marketing-sample-engine:v1', JSON.stringify(old));
    const c = (await engine().getCampaign('CMP-OLD'))!;
    expect(c.schedule).toMatchObject({
      startDate: '2026-11-01',
      allDay: false,
      timeWindow: { from: '14:00', to: '17:00' },
      expiresAfterIssueDays: 7,
    });
    expect(c.offer.deliveryFeeCoveredSar).toBe('FULL');
    expect(c.communication.respectConsent).toBe(true);
  });

  it("refuses a second campaign with the same name, like the CRM's engine", async () => {
    const e = engine();
    await e.saveCampaign(draft('Lunch deal'));
    await expect(e.saveCampaign(draft('lunch DEAL'))).rejects.toThrow(/campaign\.name\.en/);
  });

  it("refuses a bundle priced at or above its items' normal total", async () => {
    const e = engine();
    const [a, b] = (await e.catalogue()).products;
    const d = draft('Bundle');
    const bundle = {
      ...d,
      offer: {
        ...d.offer,
        type: 'BUNDLE' as const,
        bundle: { productIds: [a!.id, b!.id], priceSar: a!.priceSar + b!.priceSar },
      },
    };
    await expect(e.saveCampaign(bundle)).rejects.toThrow(/normal total/);
    const ok = {
      ...bundle,
      offer: { ...bundle.offer, bundle: { ...bundle.offer.bundle, priceSar: 1 } },
    };
    expect((await e.saveCampaign(ok)).offer.bundle?.priceSar).toBe(1);
  });
});
