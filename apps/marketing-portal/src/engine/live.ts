import { resolveUrl } from '@yiji/shared-config';
import type {
  Campaign,
  CampaignDraft,
  CampaignForecast,
  CampaignPerformance,
  CampaignStatus,
  CheckoutSimulation,
  CustomerGroup,
  EarningRule,
  EngineCatalogue,
  GiftCardActivity,
  GiftCardProduct,
  GiftCardStats,
  HomeSummary,
  IssuanceResult,
  Liability,
  MarketingEngine,
  MoneyModel,
  Opportunity,
  OrdersExportRow,
  Redemption,
  RewardsCampaign,
  RewardsItem,
  RewardsMember,
  RewardsStats,
  Study,
} from '@yiji/shared-types';
import { auth } from '../lib/directus.js';

/**
 * THE LIVE ENGINE: Yiji v2's promotion engine, reached through the CRM's
 * gateway (`/commerce/marketing/engine/*`). The browser holds no v2
 * credential - the gateway checks this person may use the Marketing portal,
 * adds the engine key and forwards. Every path here is one line of the
 * contract in docs/MARKETING-ENGINE-CONTRACT.md; v2 implements them under
 * its `/v1/...` and the gateway maps 1:1.
 */
const GATEWAY_URL = resolveUrl(
  'AI_GATEWAY_URL',
  import.meta.env.VITE_AI_GATEWAY_URL as string | undefined,
  'http://localhost:8081',
);
const BASE = `${GATEWAY_URL}/commerce/marketing/engine`;

export class EngineError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<T> {
  const token = await auth.getToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const out = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new EngineError(out.error ?? `http_${res.status}`, res.status);
  return out.data as T;
}

export class LiveMarketingEngine implements MarketingEngine {
  readonly kind = 'live' as const;
  home() {
    return call<HomeSummary>('GET', '/home');
  }
  catalogue() {
    return call<EngineCatalogue>('GET', '/catalogue');
  }
  moneyModel() {
    return call<MoneyModel>('GET', '/money-model');
  }
  listCampaigns(
    filter: { status?: CampaignStatus | 'all'; objective?: CampaignDraft['objective'] } = {},
  ) {
    return call<Campaign[]>('GET', '/campaigns', undefined, {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.objective ? { objective: filter.objective } : {}),
    });
  }
  getCampaign(id: string) {
    return call<Campaign | null>('GET', `/campaigns/${encodeURIComponent(id)}`);
  }
  saveCampaign(draft: CampaignDraft, id?: string) {
    return id
      ? call<Campaign>('PUT', `/campaigns/${encodeURIComponent(id)}`, draft)
      : call<Campaign>('POST', '/campaigns', draft);
  }
  submitForApproval(id: string, forecast: CampaignForecast) {
    return call<Campaign>('POST', `/campaigns/${encodeURIComponent(id)}/submit`, { forecast });
  }
  decideCampaign(id: string, decision: 'approve' | 'reject', note: string) {
    return call<Campaign>('POST', `/campaigns/${encodeURIComponent(id)}/decision`, {
      decision,
      note,
    });
  }
  setCampaignStatus(id: string, status: 'live' | 'paused' | 'ended') {
    return call<Campaign>('POST', `/campaigns/${encodeURIComponent(id)}/status`, { status });
  }
  issue(campaignId: string, customerIds: string[]) {
    return call<IssuanceResult>('POST', '/issuance', { campaignId, customerIds });
  }
  performance(campaignId: string) {
    return call<CampaignPerformance>(
      'GET',
      `/campaigns/${encodeURIComponent(campaignId)}/performance`,
    );
  }
  redemptions(campaignId: string, limit = 50) {
    return call<Redemption[]>(
      'GET',
      `/campaigns/${encodeURIComponent(campaignId)}/redemptions`,
      undefined,
      { limit: String(limit) },
    );
  }
  liability() {
    return call<Liability>('GET', '/liability');
  }
  giftCardProducts() {
    return call<GiftCardProduct[]>('GET', '/gift-cards/products');
  }
  saveGiftCardProduct(p: Omit<GiftCardProduct, 'id'>, id?: string) {
    return id
      ? call<GiftCardProduct>('PUT', `/gift-cards/products/${encodeURIComponent(id)}`, p)
      : call<GiftCardProduct>('POST', '/gift-cards/products', p);
  }
  giftCardStats(range: { from: string; to: string }) {
    return call<GiftCardStats>('GET', '/gift-cards/stats', undefined, range);
  }
  giftCardActivity(limit = 40) {
    return call<GiftCardActivity[]>('GET', '/gift-cards/activity', undefined, {
      limit: String(limit),
    });
  }
  earningRules() {
    return call<EarningRule[]>('GET', '/rewards/earning-rules');
  }
  saveEarningRule(r: Omit<EarningRule, 'id'>, id?: string) {
    return id
      ? call<EarningRule>('PUT', `/rewards/earning-rules/${encodeURIComponent(id)}`, r)
      : call<EarningRule>('POST', '/rewards/earning-rules', r);
  }
  rewardsCampaigns() {
    return call<RewardsCampaign[]>('GET', '/rewards/campaigns');
  }
  rewardsItems() {
    return call<RewardsItem[]>('GET', '/rewards/items');
  }
  rewardsStats() {
    return call<RewardsStats>('GET', '/rewards/stats');
  }
  rewardsMembers(query = '', limit = 50) {
    return call<RewardsMember[]>('GET', '/rewards/members', undefined, {
      q: query,
      limit: String(limit),
    });
  }
  ordersExport(range: { from: string; to: string }) {
    return call<OrdersExportRow[]>('GET', '/orders/export', undefined, range);
  }
  simulateCheckout(input: Parameters<MarketingEngine['simulateCheckout']>[0]) {
    return call<CheckoutSimulation>('POST', '/checkout/simulate', input);
  }
  listStudies() {
    return call<Study[]>('GET', '/studies');
  }
  getStudy(id: string) {
    return call<Study | null>('GET', `/studies/${encodeURIComponent(id)}`);
  }
  saveStudy(study: Study) {
    return call<Study>('PUT', `/studies/${encodeURIComponent(study.id)}`, study);
  }
  opportunities(range: { from: string; to: string }) {
    return call<Opportunity[]>('GET', '/studies/opportunities', undefined, range);
  }
  customerGroups(range: { from: string; to: string }) {
    return call<CustomerGroup[]>('GET', '/studies/customer-groups', undefined, range);
  }
}
