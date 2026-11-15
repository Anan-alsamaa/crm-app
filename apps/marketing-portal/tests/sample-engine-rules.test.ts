import { beforeEach, describe, expect, it } from 'vitest';
import { forecastCampaign, objectiveSpec, type Campaign } from '@yiji/shared-types';
import {
  CampaignDraftFromSpec,
  SampleMarketingEngine,
  resetSampleEngine,
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
    validity: { startDate: '2026-11-16', endDate: '2026-12-16', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
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

  it('refuses a change to the discount once live, but still allows the budget to grow', async () => {
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
    const saved = await engine().saveCampaign(biggerBudget, c.id);
    expect(saved.limits.budgetSar).toBe(live.limits.budgetSar + 1000);
    expect(saved.status).toBe('live');
  });
});
