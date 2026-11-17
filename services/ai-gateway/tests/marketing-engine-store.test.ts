import { describe, expect, it, vi } from 'vitest';
import {
  DirectusEngineStore,
  StoreError,
  campaignToRow,
  rowToCampaign,
  rowToEarningRule,
  rowToGiftCard,
  rowToStudy,
} from '../src/marketing/engine-store.js';
import { issuableDraft } from './marketing-engine-fixture.js';
import type { Campaign } from '@yiji/shared-types';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string; body: unknown; auth: string };

function setup(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: String((init?.headers as Record<string, string>)?.authorization ?? ''),
    };
    calls.push(c);
    return answer(c);
  });
  const store = new DirectusEngineStore('https://d.test/', 'svc-token', fetchImpl as never);
  return { store, calls };
}

const campaign: Campaign = {
  ...issuableDraft(),
  id: 'CMP-2611-1234',
  status: 'approved',
  createdBy: 'u-maker',
  createdAt: '2026-11-16T09:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
  approval: {
    requestedBy: 'u-maker',
    requestedAt: '2026-11-16T09:30:00.000Z',
    decidedBy: 'u-checker',
    decidedAt: '2026-11-16T10:00:00.000Z',
    note: 'ok',
  },
  snapshot: null,
  changeLog: [{ at: '2026-11-16T09:00:00.000Z', by: 'u-maker', what: 'created' }],
};

describe('the engine store: rows', () => {
  it('a campaign survives the row and back, including JSON stored as text', () => {
    const row = campaignToRow(campaign);
    expect(rowToCampaign(row)).toEqual(campaign);
    const asText = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : v]),
    );
    expect(rowToCampaign(asText)).toEqual(campaign);
    expect(campaignToRow({ ...campaign, status: 'rejected' }).status).toBe('archived');
  });

  it('decimals come back as numbers, missing JSON as safe defaults', () => {
    expect(
      rowToGiftCard({
        code: 'GC-1',
        name_en: 'a',
        name_ar: 'b',
        value_sar: '50.00',
        price_sar: '45',
        validity_days: 365,
        design: null,
        active: true,
      }),
    ).toMatchObject({
      valueSar: 50,
      priceSar: 45,
      design: { background: '' },
      canCombineWithCoupons: false,
    });
    expect(
      rowToEarningRule({
        code: 'ER-1',
        name: 'x',
        valid_from: '2026-01-01T00:00:00',
        valid_to: null,
      }),
    ).toMatchObject({
      validFrom: '2026-01-01',
      validTo: null,
      brandIds: [],
      cashbackPct: { DELIVERY: 0 },
    });
    expect(rowToCampaign({ engine_code: 'CMP-1', draft: '{bad' }).approval.decidedBy).toBeNull();
  });
});

/** A row exactly as the engine stored it before field parity (2026-11-16 build). */
const OLD_DRAFT = {
  objective: 'FREQUENT_ORDER',
  name: { en: 'Stamp card', ar: 'بطاقة' },
  funding: { source: 'YIJI_MARKETING', partnerSharePct: 0 },
  tenantId: 'yiji',
  offer: {
    type: 'BXGY',
    bxgy: { buyQty: 2, getQty: 1, productIds: ['CA-019', 'CA-020'] },
    deliveryFeeCovered: 'FULL',
    onRefund: 'RETURN_IF_VALID',
    onCancelBeforeCompletion: 'REISSUE_IF_VALID',
  },
  loyalty: {
    stampsRequired: 5,
    reward: 'Free pasta',
    stampExpiryDays: 60,
    milestones: [],
    minOrderToCountSar: 30,
    countOrdersFrom: 'ANY',
    repeat: true,
    progressMessages: true,
  },
  audience: { mode: 'ALL', conditions: [], match: 'ALL', phoneNumbers: [] },
  rules: { minOrderSar: 30, maxOrderSar: 0, previousOrders: 'ANY', firstOrderOnly: false },
  scope: { brandIds: ['3'], orderTypes: ['DELIVERY'] },
  limits: { perCustomerMode: 'ONE', totalRedemptions: 100, budgetSar: 1000 },
  distribution: { codeType: 'NONE', channels: ['APP_WALLET', 'PUSH'] },
  validity: {
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    startTime: '14:00',
    endTime: '17:00',
    daysOfWeek: [0, 1, 2],
  },
};

describe('the engine store: rows stored before field parity still open', () => {
  it("reads the old shape in the design's shape, losing nothing", () => {
    const c = rowToCampaign({ engine_code: 'CMP-OLD', engine_status: 'live', draft: OLD_DRAFT });
    expect(c.schedule).toEqual({
      startDate: '2026-11-01',
      endDate: '2026-11-30',
      allDay: false,
      timeWindow: { from: '14:00', to: '17:00' },
      onlyDuringBranchHours: false,
      daysOfWeek: [0, 1, 2],
      expiresAfterIssueDays: 30,
      limitedTime: { enabled: false },
    });
    expect((c as unknown as Record<string, unknown>).validity).toBeUndefined();
    expect(c.offer.bxgy).toEqual({ buyQty: 2, getQty: 1, productId: 'CA-019' });
    expect(c.offer.deliveryFeeCoveredSar).toBe('FULL');
    expect(c.loyalty).toMatchObject({ type: 'STAMP', ordersRequired: 5 });
    expect(c.notes).toBe('Loyalty reward: Free pasta');
    expect(c.scope).toMatchObject({ allBrands: false, brandIds: ['3'] });
    /* the sections it never had come back with their defaults */
    expect(c.fraud).toEqual({
      onePerPhoneAndDevice: false,
      excludeStaffAndTestAccounts: false,
      blockFlaggedCustomers: false,
    });
    expect(c.communication.respectConsent).toBe(true);
    expect(c.distribution).toMatchObject({ addMode: 'AUTO_WALLET', issueMode: 'ALL_AT_ONCE' });
    /* written back, it is in the new shape only */
    const again = campaignToRow(c);
    expect(again.draft).not.toHaveProperty('validity');
    expect(again.start_date).toBe('2026-11-01');
  });

  it('a first-order coupon stored before the fraud rules gets its mandatory one-per-phone rule', () => {
    const c = rowToCampaign({
      engine_code: 'CMP-OLD2',
      draft: { ...OLD_DRAFT, objective: 'FIRST_ORDER', loyalty: undefined },
    });
    expect(c.fraud.onePerPhoneAndDevice).toBe(true);
  });

  it("an old row that breaks today's rules still opens, as stored", () => {
    /* PUSH with no message copy is refused on save today, but must still read */
    const c = rowToCampaign({
      engine_code: 'CMP-OLD3',
      draft: { ...OLD_DRAFT, loyalty: undefined },
    });
    expect(c.distribution.channels).toEqual(['APP_WALLET', 'PUSH']);
    expect(c.communication.push.title).toEqual({ en: '', ar: '' });
  });

  it("a study's scenario drafts are read in the new shape too", () => {
    const s = rowToStudy({
      study: { id: 'STU-1', scenarios: [{ id: 's1', draft: OLD_DRAFT }] },
    });
    expect(s.scenarios[0]!.draft.schedule.startDate).toBe('2026-11-01');
  });
});

describe('the engine store: Directus, as the service account only', () => {
  it('reads engine campaigns only, by code, with the service token', async () => {
    const { store, calls } = setup(() =>
      json(200, { data: [{ id: 'row-1', ...campaignToRow(campaign) }] }),
    );
    const list = await store.listCampaigns();
    expect(list).toEqual([{ rowId: 'row-1', campaign }]);
    expect(await store.getCampaign('CMP-2611-1234')).toEqual({ rowId: 'row-1', campaign });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/items/marketing_campaigns');
    expect(JSON.parse(u.searchParams.get('filter')!)).toEqual({ engine_code: { _nnull: true } });
    expect(JSON.parse(new URL(calls[1]!.url).searchParams.get('filter')!)).toEqual({
      engine_code: { _eq: 'CMP-2611-1234' },
    });
    expect(calls.every((c) => c.auth === 'Bearer svc-token')).toBe(true);
  });

  it('writes a campaign as one row and patches it by row id', async () => {
    const { store, calls } = setup((c) =>
      json(200, { data: { id: 'row-9', ...(c.body as object) } }),
    );
    expect((await store.insertCampaign(campaign)).rowId).toBe('row-9');
    await store.updateCampaign('row-9', campaign);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['POST', '/items/marketing_campaigns'],
      ['PATCH', '/items/marketing_campaigns/row-9'],
    ]);
    expect((calls[0]!.body as Record<string, unknown>).engine_code).toBe('CMP-2611-1234');
  });

  it('issuance: coupon pending -> recipients queued -> approved, decided no earlier than the last recipient', async () => {
    const later = '2026-11-16T09:00:05.000Z';
    const { store, calls } = setup((c) => {
      if (c.method === 'POST' && c.url.endsWith('/items/marketing_coupons'))
        return json(200, { data: { id: 'coupon-1' } });
      if (c.method === 'POST')
        return json(200, {
          data: (c.body as unknown[]).map((_, i) => ({
            date_created: i === 0 ? later : '2026-11-16T09:00:00Z',
          })),
        });
      return json(200, { data: {} });
    });
    const phones = Array.from({ length: 501 }, (_, i) => `05510${String(i).padStart(5, '0')}`);
    await store.createListCoupon({ code: 'MKT-ABCDEFGH', campaign: 'row-1' }, phones, {
      decidedBy: 'u-checker',
      now: () => new Date('2026-11-16T09:00:00Z'),
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /items/marketing_coupons',
      'POST /items/marketing_coupon_recipients',
      'POST /items/marketing_coupon_recipients',
      'PATCH /items/marketing_coupons/coupon-1',
    ]);
    expect(calls[0]!.body).toMatchObject({ status: 'pending', code: 'MKT-ABCDEFGH' });
    expect((calls[1]!.body as unknown[]).length).toBe(500);
    expect((calls[1]!.body as unknown[])[0]).toEqual({
      coupon: 'coupon-1',
      phone: '0551000000',
      status: 'queued',
    });
    expect(calls[3]!.body).toEqual({
      status: 'approved',
      decided_at: later,
      decided_by: 'u-checker',
    });
  });

  it('reads the recipients of every coupon of a campaign, contacts by Yiji id, the money model setting', async () => {
    const { store, calls } = setup((c) => {
      if (c.url.includes('/items/contacts'))
        return json(200, { data: [{ external_customer_id: 'y-1', phone: '0551234567' }] });
      if (c.url.includes('/items/app_settings')) return json(200, { data: [{ value: '{"x":1}' }] });
      if (c.url.includes('/items/stores'))
        return json(200, {
          data: [
            {
              id: 's1',
              name: 'Olaya',
              city: 'Riyadh',
              brand: { name: 'Okashi', yiji_brand_name: null },
            },
          ],
        });
      return json(200, { data: [] });
    });
    await store.campaignRecipients('row-1');
    expect(JSON.parse(new URL(calls[0]!.url).searchParams.get('filter')!)).toEqual({
      coupon: { campaign: { _eq: 'row-1' } },
    });
    expect([...(await store.phonesForCustomers(['y-1', 'y-2'])).entries()]).toEqual([
      ['y-1', '0551234567'],
    ]);
    expect(new URL(calls[1]!.url).searchParams.get('fields')).toBe('external_customer_id,phone');
    expect(await store.moneyModelSetting()).toBe('{"x":1}');
    expect(await store.catalogueStores()).toEqual([
      { id: 's1', name: 'Olaya', city: 'Riyadh', brandName: 'Okashi' },
    ]);
  });

  it('studies, gift cards and rules: created, then updated by their row', async () => {
    const { store, calls } = setup((c) => {
      if (c.method === 'GET') return json(200, { data: [{ id: 'row-s' }] });
      return json(200, { data: { ...(c.body as object) } });
    });
    const study = {
      id: 'STU-1',
      name: 'n',
      stage: 'draft',
      objective: 'SLOW_HOURS',
      createdBy: 'u',
      campaignId: null,
    } as never;
    await store.insertStudy(study);
    await store.updateStudy(study);
    await store.saveGiftCardProduct(
      {
        id: 'GC-1',
        name: { en: 'a', ar: 'b' },
        valueSar: 1,
        priceSar: 1,
        validityDays: 1,
        design: { background: '', accent: '', message: '' },
        active: true,
        canCombineWithCoupons: false,
      },
      false,
    );
    await store.saveEarningRule(
      {
        id: 'ER-1',
        name: 'r',
        cashbackPct: { DELIVERY: 1, PICKUP: 1, CARHOP: 1, DINE_IN: 1 },
        brandIds: [],
        active: true,
        validFrom: '2026-01-01',
        validTo: null,
      },
      true,
    );
    await store.logActivity({
      action: 'x',
      subject_type: 'campaign',
      subject_id: 'c',
      summary: 's',
    });
    expect(
      calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ).toEqual([
      'POST /items/marketing_studies',
      'PATCH /items/marketing_studies/row-s',
      'PATCH /items/marketing_gift_card_products/row-s',
      'POST /items/marketing_earning_rules',
      'POST /items/marketing_activity',
    ]);
  });

  it('a refusal throws a StoreError with the status - and never the body', async () => {
    const { store } = setup(() => json(403, { errors: [{ message: 'secret-ish detail' }] }));
    const err = await store.listStudies().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).status).toBe(403);
    expect((err as Error).message).not.toContain('secret-ish');
    const missing = setup(() => json(200, { data: [] })).store;
    await expect(missing.updateStudy({ id: 'STU-x' } as never)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('the engine store matches the schema and the grants', () => {
  it('every column it writes is declared in collections.ts', async () => {
    const { collections } = await import('../../../directus/bootstrap/src/collections.js');
    const fieldsOf = (c: string) =>
      new Set(collections.find((x) => x.collection === c)!.fields.map((f) => f.field));
    const campaignCols = fieldsOf('marketing_campaigns');
    for (const k of Object.keys(campaignToRow(campaign))) expect(campaignCols, k).toContain(k);
    const { studyToRow, giftCardToRow, earningRuleToRow } =
      await import('../src/marketing/engine-store.js');
    for (const k of Object.keys(studyToRow({ id: 'S' } as never)))
      expect(fieldsOf('marketing_studies'), k).toContain(k);
    for (const k of Object.keys(
      giftCardToRow({ id: 'G', name: { en: '', ar: '' }, design: {} } as never),
    ))
      expect(fieldsOf('marketing_gift_card_products'), k).toContain(k);
    for (const k of Object.keys(earningRuleToRow({ id: 'E' } as never)))
      expect(fieldsOf('marketing_earning_rules'), k).toContain(k);
  });

  it('svc-ai-gateway is granted exactly what the engine does, and no delete', async () => {
    const { roles } = await import('../../../directus/bootstrap/src/roles.js');
    const perms = roles.find((r) => r.name === 'svc-ai-gateway')!.permissions!;
    const has = (collection: string, action: string) =>
      perms.find((p) => p.collection === collection && p.action === action);
    for (const c of [
      'marketing_campaigns',
      'marketing_studies',
      'marketing_gift_card_products',
      'marketing_earning_rules',
    ])
      for (const a of ['create', 'read', 'update']) expect(has(c, a), `${c} ${a}`).toBeTruthy();
    expect(has('marketing_activity', 'create')).toBeTruthy();
    expect(has('marketing_activity', 'update')).toBeFalsy();
    expect(has('marketing_coupons', 'create')).toBeTruthy();
    expect(has('marketing_coupons', 'update')!.fields).toEqual([
      'status',
      'decided_at',
      'decided_by',
    ]);
    expect(has('marketing_coupon_recipients', 'create')).toBeTruthy();
    expect(has('marketing_coupon_recipients', 'update')).toBeFalsy();
    expect(has('contacts', 'read')!.fields).toEqual(['id', 'external_customer_id', 'phone']);
    for (const c of ['stores', 'brands', 'app_settings']) expect(has(c, 'read'), c).toBeTruthy();
    expect(
      perms.filter((p) => p.collection.startsWith('marketing_') && p.action === 'delete'),
    ).toEqual([]);
  });
});
