import {
  CampaignDraftShape,
  readCampaignDraft,
  type Campaign,
  type CampaignDraft,
  type EarningRule,
  type GiftCardProduct,
  type Study,
} from '@yiji/shared-types';

/**
 * WHERE THE CRM'S MARKETING ENGINE KEEPS ITS DATA (owner, 2026-11-16: the CRM
 * owns its marketing backend; Yiji v2 implements nothing for it).
 *
 * Directus collections, written ONLY by the gateway's service account after
 * the engine's rules have run (`crm-engine.ts`). People read them; nobody
 * writes them directly, so four eyes and the live-campaign locks cannot be
 * stepped around from the Directus app.
 *
 *   marketing_campaigns          - the campaign: typed columns for lists and
 *                                  filters, the whole validated draft (every
 *                                  field of CAMPAIGN_FIELD_SPEC) in `draft`
 *   marketing_studies            - pre-studies, whole, in `study`
 *   marketing_gift_card_products - gift card products
 *   marketing_earning_rules      - points earning rules
 *   marketing_coupons + _recipients - issuance, through the EXISTING sender
 *   marketing_activity           - the append-only log
 *
 * The interface is the seam the tests use (an in-memory store) and the only
 * thing `crm-engine.ts` knows about storage.
 */

export interface CampaignRecord {
  /** The Directus row id (uuid) - what a marketing coupon's `campaign` points at. */
  rowId: string;
  campaign: Campaign;
}

export interface RecipientRow {
  phone: string;
  status: 'queued' | 'sent' | 'no_account' | 'failed' | string;
  sent_at: string | null;
  date_created: string | null;
  /** The batch's coupon status: 'pending' / 'cancelled' = never released. */
  couponStatus?: string | null;
}

export interface CatalogueStore {
  id: string;
  name: string;
  city: string | null;
  brandName: string | null;
}

export interface ActivityEntry {
  action: string;
  subject_type: string;
  subject_id: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface EngineStore {
  listCampaigns(): Promise<CampaignRecord[]>;
  getCampaign(id: string): Promise<CampaignRecord | null>;
  insertCampaign(c: Campaign): Promise<CampaignRecord>;
  updateCampaign(rowId: string, c: Campaign): Promise<CampaignRecord>;

  listStudies(): Promise<Study[]>;
  getStudy(id: string): Promise<Study | null>;
  insertStudy(s: Study): Promise<Study>;
  updateStudy(s: Study): Promise<Study>;

  listGiftCardProducts(): Promise<GiftCardProduct[]>;
  saveGiftCardProduct(p: GiftCardProduct, isNew: boolean): Promise<GiftCardProduct>;
  listEarningRules(): Promise<EarningRule[]>;
  saveEarningRule(r: EarningRule, isNew: boolean): Promise<EarningRule>;

  /** Every recipient of every coupon issued for this campaign row. */
  campaignRecipients(rowId: string): Promise<RecipientRow[]>;
  /**
   * One list coupon for the existing marketing sender: the coupon row is
   * written `pending`, its recipients `queued`, and only THEN the coupon is
   * marked `approved` with a decision time after the last recipient - the
   * sender never sends to a recipient written after the decision.
   */
  createListCoupon(
    coupon: Record<string, unknown>,
    phones: string[],
    decision: { decidedBy: string | null; now: () => Date },
  ): Promise<{ couponId: string }>;

  logActivity(entry: ActivityEntry): Promise<void>;

  catalogueStores(): Promise<CatalogueStore[]>;
  /** The CRM contact phone for each Yiji customer id we know (`external_customer_id`). */
  phonesForCustomers(ids: string[]): Promise<Map<string, string>>;
  /** `app_settings.marketing_money_model`, or null. */
  moneyModelSetting(): Promise<unknown>;
}

/* ── row mapping (pure, tested field by field) ─────────────────────────── */

const DRAFT_KEYS = Object.keys(CampaignDraftShape.shape) as Array<keyof CampaignDraft>;

/** The draft part of a campaign: exactly the keys of the CampaignDraft schema. */
export function draftOf(c: Partial<Campaign>): Partial<CampaignDraft> {
  const out: Record<string, unknown> = {};
  for (const k of DRAFT_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out as Partial<CampaignDraft>;
}

export function campaignToRow(c: Campaign): Record<string, unknown> {
  return {
    engine_code: c.id,
    engine_status: c.status,
    objective: c.objective,
    offer_type: c.offer.type,
    tenant_id: c.tenantId,
    study_code: c.studyId ?? null,
    prepared_by: c.createdBy,
    prepared_at: c.createdAt,
    engine_updated_at: c.updatedAt,
    /* The legacy columns the Campaigns page has always shown, kept in step so
       an engine campaign reads sensibly there too. Never read back. */
    name: c.name.en,
    name_ar: c.name.ar,
    goal: c.notes ?? null,
    start_date: c.schedule.startDate,
    end_date: c.schedule.endDate,
    budget: c.limits.budgetSar,
    status: c.status === 'ended' || c.status === 'rejected' ? 'archived' : 'active',
    draft: draftOf(c),
    approval: c.approval,
    snapshot: c.snapshot,
    change_log: c.changeLog,
  };
}

const json = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

/**
 * A row back to a campaign. The draft is read through `readCampaignDraft`:
 * a row stored before field parity (2026-11-17: `validity`, `stampsRequired`,
 * `bxgy.productIds`, ...) comes back in today's shape, and a row that no
 * longer passes today's rules still opens - it is re-checked when saved.
 */
export function rowToCampaign(row: Record<string, unknown>): Campaign {
  const draft = readCampaignDraft(json<unknown>(row.draft, {}));
  return {
    ...draft,
    id: String(row.engine_code),
    status: String(row.engine_status ?? 'draft') as Campaign['status'],
    createdBy: String(row.prepared_by ?? ''),
    createdAt: String(row.prepared_at ?? row.date_created ?? ''),
    updatedAt: String(row.engine_updated_at ?? row.date_updated ?? row.prepared_at ?? ''),
    approval: json(row.approval, {
      requestedBy: null,
      requestedAt: null,
      decidedBy: null,
      decidedAt: null,
      note: null,
    }),
    snapshot: json(row.snapshot, null),
    changeLog: json(row.change_log, []),
  };
}

export function studyToRow(s: Study): Record<string, unknown> {
  return {
    code: s.id,
    name: s.name,
    stage: s.stage,
    objective: s.objective,
    prepared_by: s.createdBy,
    campaign_code: s.campaignId,
    study: s,
  };
}

export function rowToStudy(row: Record<string, unknown>): Study {
  const s = json<Study>(row.study, null as unknown as Study);
  if (!s || !Array.isArray(s.scenarios)) return s;
  /* A scenario's draft is a campaign draft too: read it in today's shape. */
  return { ...s, scenarios: s.scenarios.map((x) => ({ ...x, draft: readCampaignDraft(x.draft) })) };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function giftCardToRow(p: GiftCardProduct): Record<string, unknown> {
  return {
    code: p.id,
    name_en: p.name.en,
    name_ar: p.name.ar,
    value_sar: p.valueSar,
    price_sar: p.priceSar,
    validity_days: p.validityDays,
    design: p.design,
    active: p.active,
    can_combine_with_coupons: p.canCombineWithCoupons,
  };
}

export function rowToGiftCard(row: Record<string, unknown>): GiftCardProduct {
  return {
    id: String(row.code),
    name: { en: String(row.name_en ?? ''), ar: String(row.name_ar ?? '') },
    valueSar: num(row.value_sar),
    priceSar: num(row.price_sar),
    validityDays: num(row.validity_days),
    design: json(row.design, { background: '', accent: '', message: '' }),
    active: row.active === true,
    canCombineWithCoupons: row.can_combine_with_coupons === true,
  };
}

export function earningRuleToRow(r: EarningRule): Record<string, unknown> {
  return {
    code: r.id,
    name: r.name,
    cashback_pct: r.cashbackPct,
    brand_ids: r.brandIds,
    active: r.active,
    valid_from: r.validFrom,
    valid_to: r.validTo,
  };
}

export function rowToEarningRule(row: Record<string, unknown>): EarningRule {
  return {
    id: String(row.code),
    name: String(row.name ?? ''),
    cashbackPct: json(row.cashback_pct, { DELIVERY: 0, PICKUP: 0, CARHOP: 0, DINE_IN: 0 }),
    brandIds: json(row.brand_ids, []),
    active: row.active === true,
    validFrom: String(row.valid_from ?? '').slice(0, 10),
    validTo: row.valid_to ? String(row.valid_to).slice(0, 10) : null,
  };
}

/* ── Directus, over REST, as the gateway's service account ─────────────── */

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

interface Query {
  filter?: Record<string, unknown>;
  fields?: string[];
  sort?: string[];
  limit?: number;
}

const CHUNK = 500;

export class DirectusEngineStore implements EngineStore {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(
    directusUrl: string,
    private readonly token: string,
    fetchImpl?: typeof fetch,
  ) {
    this.base = directusUrl.replace(/\/+$/, '');
    this.f = fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      /* The collection name and status only - never the body, which may echo
         what was written. */
      throw new StoreError(`directus ${method} ${path.split('?')[0]} ${res.status}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    const out = (await res.json().catch(() => ({}))) as { data?: T };
    return out.data as T;
  }

  private list<T = Record<string, unknown>>(collection: string, q: Query = {}): Promise<T[]> {
    const p = new URLSearchParams();
    if (q.filter) p.set('filter', JSON.stringify(q.filter));
    p.set('fields', (q.fields ?? ['*']).join(','));
    if (q.sort) p.set('sort', q.sort.join(','));
    p.set('limit', String(q.limit ?? -1));
    return this.req<T[]>('GET', `/items/${collection}?${p.toString()}`).then((r) => r ?? []);
  }
  private create<T = Record<string, unknown>>(collection: string, body: unknown): Promise<T> {
    return this.req<T>('POST', `/items/${collection}`, body);
  }
  private update<T = Record<string, unknown>>(
    collection: string,
    id: string,
    body: unknown,
  ): Promise<T> {
    return this.req<T>('PATCH', `/items/${collection}/${encodeURIComponent(id)}`, body);
  }

  /* campaigns */
  async listCampaigns(): Promise<CampaignRecord[]> {
    const rows = await this.list('marketing_campaigns', {
      filter: { engine_code: { _nnull: true } },
      sort: ['-prepared_at'],
    });
    return rows.map((r) => ({ rowId: String(r.id), campaign: rowToCampaign(r) }));
  }
  async getCampaign(id: string): Promise<CampaignRecord | null> {
    const rows = await this.list('marketing_campaigns', {
      filter: { engine_code: { _eq: id } },
      limit: 1,
    });
    const r = rows[0];
    return r ? { rowId: String(r.id), campaign: rowToCampaign(r) } : null;
  }
  async insertCampaign(c: Campaign): Promise<CampaignRecord> {
    const r = await this.create('marketing_campaigns', campaignToRow(c));
    return { rowId: String(r.id), campaign: rowToCampaign(r) };
  }
  async updateCampaign(rowId: string, c: Campaign): Promise<CampaignRecord> {
    const r = await this.update('marketing_campaigns', rowId, campaignToRow(c));
    return { rowId, campaign: rowToCampaign(r) };
  }

  /* studies */
  async listStudies(): Promise<Study[]> {
    const rows = await this.list('marketing_studies', { sort: ['-date_created'] });
    return rows.map(rowToStudy).filter(Boolean);
  }
  async getStudy(id: string): Promise<Study | null> {
    const rows = await this.list('marketing_studies', { filter: { code: { _eq: id } }, limit: 1 });
    return rows[0] ? rowToStudy(rows[0]) : null;
  }
  async insertStudy(s: Study): Promise<Study> {
    return rowToStudy(await this.create('marketing_studies', studyToRow(s)));
  }
  async updateStudy(s: Study): Promise<Study> {
    const rows = await this.list<{ id: string }>('marketing_studies', {
      filter: { code: { _eq: s.id } },
      fields: ['id'],
      limit: 1,
    });
    if (!rows[0]) throw new StoreError('study row missing', 404);
    return rowToStudy(await this.update('marketing_studies', rows[0].id, studyToRow(s)));
  }

  /* gift cards and earning rules */
  async listGiftCardProducts(): Promise<GiftCardProduct[]> {
    return (await this.list('marketing_gift_card_products', { sort: ['date_created'] })).map(
      rowToGiftCard,
    );
  }
  async saveGiftCardProduct(p: GiftCardProduct, isNew: boolean): Promise<GiftCardProduct> {
    if (isNew)
      return rowToGiftCard(await this.create('marketing_gift_card_products', giftCardToRow(p)));
    const rowId = await this.rowIdByCode('marketing_gift_card_products', p.id);
    return rowToGiftCard(
      await this.update('marketing_gift_card_products', rowId, giftCardToRow(p)),
    );
  }
  async listEarningRules(): Promise<EarningRule[]> {
    return (await this.list('marketing_earning_rules', { sort: ['date_created'] })).map(
      rowToEarningRule,
    );
  }
  async saveEarningRule(r: EarningRule, isNew: boolean): Promise<EarningRule> {
    if (isNew)
      return rowToEarningRule(await this.create('marketing_earning_rules', earningRuleToRow(r)));
    const rowId = await this.rowIdByCode('marketing_earning_rules', r.id);
    return rowToEarningRule(
      await this.update('marketing_earning_rules', rowId, earningRuleToRow(r)),
    );
  }
  private async rowIdByCode(collection: string, code: string): Promise<string> {
    const rows = await this.list<{ id: string }>(collection, {
      filter: { code: { _eq: code } },
      fields: ['id'],
      limit: 1,
    });
    if (!rows[0]) throw new StoreError(`${collection} row missing`, 404);
    return rows[0].id;
  }

  /* issuance, through the existing marketing coupon sender */
  async campaignRecipients(rowId: string): Promise<RecipientRow[]> {
    const rows = await this.list<RecipientRow & { coupon?: { status?: string | null } | null }>(
      'marketing_coupon_recipients',
      {
        filter: { coupon: { campaign: { _eq: rowId } } },
        fields: ['phone', 'status', 'sent_at', 'date_created', 'coupon.status'],
      },
    );
    return rows.map(({ coupon, ...r }) => ({ ...r, couponStatus: coupon?.status ?? null }));
  }
  async createListCoupon(
    coupon: Record<string, unknown>,
    phones: string[],
    decision: { decidedBy: string | null; now: () => Date },
  ): Promise<{ couponId: string }> {
    const row = await this.create<{ id: string }>('marketing_coupons', {
      ...coupon,
      status: 'pending',
    });
    const couponId = String(row.id);
    let latest = '';
    try {
      for (let i = 0; i < phones.length; i += CHUNK) {
        const made = await this.create<Array<{ date_created?: string | null }>>(
          'marketing_coupon_recipients',
          phones
            .slice(i, i + CHUNK)
            .map((phone) => ({ coupon: couponId, phone, status: 'queued' })),
        );
        for (const m of Array.isArray(made) ? made : [])
          if (m?.date_created && m.date_created > latest) latest = m.date_created;
      }
    } catch (err) {
      /* A batch that broke halfway is CANCELLED, never left pending where a
         person could approve it in the coupon queue (review 2026-11-16); its
         recipients count as holding nothing, so a retry reaches them. */
      await this.update('marketing_coupons', couponId, { status: 'cancelled' }).catch(
        () => undefined,
      );
      throw err;
    }
    /* The decision time is never before the last recipient was written, by
       either clock: the sender reads `date_created <= decided_at`. */
    const now = decision.now().toISOString();
    const decidedAt = latest && Date.parse(latest) > Date.parse(now) ? latest : now;
    await this.update('marketing_coupons', couponId, {
      status: 'approved',
      decided_at: decidedAt,
      decided_by: decision.decidedBy,
    });
    return { couponId };
  }

  async logActivity(entry: ActivityEntry): Promise<void> {
    await this.create('marketing_activity', entry);
  }

  async catalogueStores(): Promise<CatalogueStore[]> {
    const rows = await this.list<{
      id: string;
      name?: string | null;
      city?: string | null;
      brand?: { name?: string | null; yiji_brand_name?: string | null } | null;
    }>('stores', {
      filter: { status: { _neq: 'archived' } },
      fields: ['id', 'name', 'city', 'brand.name', 'brand.yiji_brand_name'],
      sort: ['name'],
    });
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      city: r.city ?? null,
      brandName: r.brand?.yiji_brand_name || r.brand?.name || null,
    }));
  }

  async phonesForCustomers(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await this.list<{ external_customer_id?: string | null; phone?: string | null }>(
        'contacts',
        {
          filter: { external_customer_id: { _in: ids.slice(i, i + CHUNK) } },
          fields: ['external_customer_id', 'phone'],
        },
      );
      for (const r of rows)
        if (r.external_customer_id && r.phone && !out.has(r.external_customer_id))
          out.set(String(r.external_customer_id), String(r.phone));
    }
    return out;
  }

  async moneyModelSetting(): Promise<unknown> {
    const rows = await this.list<{ value: unknown }>('app_settings', {
      filter: { key: { _eq: 'marketing_money_model' } },
      fields: ['value'],
      limit: 1,
    });
    return rows[0]?.value ?? null;
  }
}
