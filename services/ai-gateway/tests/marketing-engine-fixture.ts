import {
  CampaignDraft,
  type Campaign,
  type EarningRule,
  type GiftCardProduct,
  type Study,
} from '@yiji/shared-types';
import {
  campaignToRow,
  earningRuleToRow,
  giftCardToRow,
  rowToCampaign,
  rowToEarningRule,
  rowToGiftCard,
  rowToStudy,
  studyToRow,
  type ActivityEntry,
  type CampaignRecord,
  type CatalogueStore,
  type EngineStore,
  type RecipientRow,
} from '../src/marketing/engine-store.js';
import type { Actor } from '../src/marketing/crm-engine.js';

/**
 * An in-memory EngineStore for the engine and route tests. Rows go through
 * the SAME row mapping the Directus store uses (and a JSON round trip, as
 * Directus would), so what the tests read back is what Directus would hold.
 */
export class MemoryEngineStore implements EngineStore {
  campaigns: Array<{ id: string; row: Record<string, unknown> }> = [];
  studies: Array<Record<string, unknown>> = [];
  gifts: Array<Record<string, unknown>> = [];
  rules: Array<Record<string, unknown>> = [];
  coupons: Array<{ id: string; row: Record<string, unknown> }> = [];
  recipients: Array<RecipientRow & { coupon: string }> = [];
  activity: ActivityEntry[] = [];
  stores: CatalogueStore[] = [];
  contacts = new Map<string, string>();
  moneyModel: unknown = null;
  private seq = 0;
  private wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  async listCampaigns(): Promise<CampaignRecord[]> {
    return this.campaigns.map((c) => ({ rowId: c.id, campaign: rowToCampaign(this.wire(c.row)) }));
  }
  async getCampaign(id: string): Promise<CampaignRecord | null> {
    const c = this.campaigns.find((x) => x.row.engine_code === id);
    return c ? { rowId: c.id, campaign: rowToCampaign(this.wire(c.row)) } : null;
  }
  async insertCampaign(c: Campaign): Promise<CampaignRecord> {
    const id = `row-${++this.seq}`;
    this.campaigns.push({ id, row: this.wire(campaignToRow(c)) });
    return { rowId: id, campaign: rowToCampaign(this.wire(campaignToRow(c))) };
  }
  async updateCampaign(rowId: string, c: Campaign): Promise<CampaignRecord> {
    const x = this.campaigns.find((r) => r.id === rowId)!;
    x.row = this.wire(campaignToRow(c));
    return { rowId, campaign: rowToCampaign(this.wire(x.row)) };
  }
  async listStudies(): Promise<Study[]> {
    return this.studies.map((r) => rowToStudy(this.wire(r)));
  }
  async getStudy(id: string): Promise<Study | null> {
    const r = this.studies.find((x) => x.code === id);
    return r ? rowToStudy(this.wire(r)) : null;
  }
  async insertStudy(s: Study): Promise<Study> {
    this.studies.push(this.wire(studyToRow(s)));
    return this.wire(s);
  }
  async updateStudy(s: Study): Promise<Study> {
    const i = this.studies.findIndex((x) => x.code === s.id);
    this.studies[i] = this.wire(studyToRow(s));
    return this.wire(s);
  }
  async listGiftCardProducts(): Promise<GiftCardProduct[]> {
    return this.gifts.map((r) => rowToGiftCard(this.wire(r)));
  }
  async saveGiftCardProduct(p: GiftCardProduct, isNew: boolean): Promise<GiftCardProduct> {
    const row = this.wire(giftCardToRow(p));
    if (isNew) this.gifts.push(row);
    else this.gifts[this.gifts.findIndex((x) => x.code === p.id)] = row;
    return rowToGiftCard(row);
  }
  async listEarningRules(): Promise<EarningRule[]> {
    return this.rules.map((r) => rowToEarningRule(this.wire(r)));
  }
  async saveEarningRule(r: EarningRule, isNew: boolean): Promise<EarningRule> {
    const row = this.wire(earningRuleToRow(r));
    if (isNew) this.rules.push(row);
    else this.rules[this.rules.findIndex((x) => x.code === r.id)] = row;
    return rowToEarningRule(row);
  }
  async campaignRecipients(rowId: string): Promise<RecipientRow[]> {
    const mine = new Set(this.coupons.filter((c) => c.row.campaign === rowId).map((c) => c.id));
    return this.recipients.filter((r) => mine.has(r.coupon));
  }
  async createListCoupon(
    coupon: Record<string, unknown>,
    phones: string[],
    decision: { decidedBy: string | null; now: () => Date },
  ): Promise<{ couponId: string }> {
    const id = `coupon-${++this.seq}`;
    this.coupons.push({ id, row: { ...coupon, status: 'pending' } });
    for (const phone of phones)
      this.recipients.push({
        coupon: id,
        phone,
        status: 'queued',
        sent_at: null,
        date_created: decision.now().toISOString(),
      });
    Object.assign(this.coupons.at(-1)!.row, {
      status: 'approved',
      decided_at: decision.now().toISOString(),
      decided_by: decision.decidedBy,
    });
    return { couponId: id };
  }
  async logActivity(entry: ActivityEntry): Promise<void> {
    this.activity.push(entry);
  }
  async catalogueStores(): Promise<CatalogueStore[]> {
    return this.stores;
  }
  async phonesForCustomers(ids: string[]): Promise<Map<string, string>> {
    return new Map(ids.filter((i) => this.contacts.has(i)).map((i) => [i, this.contacts.get(i)!]));
  }
  async moneyModelSetting(): Promise<unknown> {
    return this.moneyModel;
  }
}

export const maker: Actor = {
  id: 'user-maker',
  isAdmin: false,
  privileges: { use_marketing_portal: true, manage_marketing: true },
};
export const checker: Actor = {
  id: 'user-checker',
  isAdmin: false,
  privileges: { use_marketing_portal: true, approve_marketing: true },
};
export const viewer: Actor = {
  id: 'user-viewer',
  isAdmin: false,
  privileges: { use_marketing_portal: true },
};
export const admin: Actor = { id: 'user-admin', isAdmin: true, privileges: {} };

/** A valid draft the v1 coupon pipeline can carry. */
export function issuableDraft(over: Partial<CampaignDraft> = {}): CampaignDraft {
  return CampaignDraft.parse({
    objective: 'LAPSED_REACTIVATION',
    name: { en: 'Come back - SAR 10 off', ar: 'عد إلينا' },
    offer: { type: 'FIXED', amountSar: 10 },
    audience: { mode: 'LIST', listId: 'list-1', controlGroupPct: 0 },
    rules: { minOrderSar: 50 },
    limits: { totalRedemptions: 3000, budgetSar: 5000 },
    validity: { startDate: '2026-11-10', endDate: '2026-12-10' },
    ...over,
  });
}

export const forecastFor = (over: Record<string, unknown> = {}) => ({
  customersMatched: 2400,
  expectedRedemptions: 500,
  expectedOrders: 500,
  avgOrderSar: 67,
  discountSar: 5000,
  revenueSar: 33500,
  extraProfitSar: 9000,
  messageCostSar: 0,
  netSar: 4000,
  roiPct: 80,
  mostItCanCostSar: 5000,
  needsApproval: false,
  approvalReasons: [],
  ...over,
});
