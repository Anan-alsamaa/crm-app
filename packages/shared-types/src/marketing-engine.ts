import { z } from 'zod';

/**
 * THE PROMOTION ENGINE CONTRACT (owner, 2026-11-15).
 *
 * The marketing portal lives in the CRM ("I'd prefer that over having the
 * marketing portal on the Yiji v2 itself"), launched together with Yiji v2.
 * Yiji v2 runs the ENGINE - it validates every cart at checkout, records
 * redemptions and holds the ledger - and the CRM is the PORTAL over it:
 * studies, campaign set-up, approval, performance, gift cards, rewards.
 *
 * This file is the seam. Every screen in the portal talks to a
 * `MarketingEngine` and nothing else; the sample-data engine runs today and
 * the live one (the CRM's gateway -> Yiji v2) is the same interface, so going
 * live is a switch, not a rebuild. It is also the exact shape Yiji v2 must
 * implement - `docs/MARKETING-ENGINE-CONTRACT.md` is written from it.
 *
 * Modelled on the operations draft "YIJI Promotions Portal" (Ayman, 2026-11-15):
 * its seven areas, its 16 coupon goals, its seven-step campaign form and its
 * four-eyes rule.
 */

/* ── vocabulary ──────────────────────────────────────────────────────────── */

export const CAMPAIGN_OBJECTIVES = [
  'NEW_CUSTOMER',
  'LAPSED_REACTIVATION',
  'RETENTION',
  'LOYALTY_REWARD',
  'FREQUENT_ORDER',
  'FIRST_ORDER',
  'REPEAT_PURCHASE',
  'SPECIFIC_ITEM',
  'MIN_ORDER_VALUE',
  'UPSELL',
  'PICKUP',
  'DELIVERY',
  'SLOW_HOURS',
  'NEW_BRANCH',
  'OCCASION',
  'SERVICE_RECOVERY',
] as const;
export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];

export const OBJECTIVE_GOALS = [
  'WIN_NEW_AND_LAPSED',
  'KEEP_AND_REWARD',
  'GROW_ORDER_VALUE',
  'SHIFT_ORDER_CHANNEL',
  'OCCASIONS_AND_RECOVERY',
] as const;
export type ObjectiveGoal = (typeof OBJECTIVE_GOALS)[number];

export const OFFER_TYPES = [
  'PERCENT',
  'FIXED',
  'BXGY',
  'FREE_ITEM',
  'BUNDLE',
  'FREE_DELIVERY',
  'CASHBACK',
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const CAMPAIGN_STATUSES = [
  'draft',
  'finance_review',
  'waiting_approval',
  'approved',
  'live',
  'paused',
  'ended',
  'rejected',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const ORDER_TYPES = ['DELIVERY', 'PICKUP', 'CARHOP', 'DINE_IN'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const PAYMENT_METHODS = ['MADA', 'CARD', 'APPLE_PAY', 'CASH', 'WALLET'] as const;
export const CHANNELS = [
  'APP_WALLET',
  'PUSH',
  'SMS',
  'EMAIL',
  'WHATSAPP',
  'IN_APP_BANNER',
] as const;

export const AUDIENCE_CONDITIONS = [
  'ORDERED_ONCE',
  'ORDERED_N_PLUS',
  'NO_ORDER_DAYS',
  'REGISTERED_DAYS',
  'TIER',
  'BRAND',
  'BRANCH',
  'CITY',
  'ORDER_TYPE',
  'AVG_ORDER_ABOVE',
  'BIRTHDAY_MONTH',
] as const;
export type AudienceCondition = (typeof AUDIENCE_CONDITIONS)[number];

/* ── the campaign, as the seven-step form builds it ─────────────────────── */

const sar = z.number().min(0);
const pct = z.number().min(0).max(100);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CampaignOffer = z.object({
  type: z.enum(OFFER_TYPES),
  percent: pct.optional(),
  amountSar: sar.optional(),
  /** Caps the saving on large orders; mandatory for PERCENT and CASHBACK. */
  maxDiscountSar: sar.optional(),
  bxgy: z
    .object({
      buyQty: z.number().int().min(1),
      getQty: z.number().int().min(1),
      productIds: z.array(z.string()),
    })
    .optional(),
  freeItem: z.object({ productId: z.string(), quantity: z.number().int().min(1) }).optional(),
  bundle: z.object({ productIds: z.array(z.string()).min(2), priceSar: sar }).optional(),
  /** FULL, or a SAR amount of the delivery fee covered. */
  deliveryFeeCovered: z.union([z.literal('FULL'), sar]).optional(),
  cashback: z.object({ creditValidityDays: z.number().int().min(1) }).optional(),
  /** Matches the discount line in the restaurant POS. */
  posDiscountCode: z.string().max(64).optional(),
  onRefund: z.enum(['RETURN_IF_VALID', 'KEEP', 'NEVER_RETURN']).default('RETURN_IF_VALID'),
  onCancelBeforeCompletion: z
    .enum(['REISSUE_IF_VALID', 'KEEP', 'NEVER_RETURN'])
    .default('REISSUE_IF_VALID'),
  partialRedemption: z
    .object({
      enabled: z.boolean().default(false),
      maxPerOrderSar: sar.optional(),
      balanceExpiry: z.enum(['SAME', 'DAYS_30', 'DAYS_90']).default('SAME'),
      onOrderCancel: z.enum(['RESTORE', 'KEEP']).default('RESTORE'),
    })
    .optional(),
});

export const CampaignExperiment = z.object({
  enabled: z.boolean().default(false),
  variantB: z.object({ value: z.number().min(0) }).optional(),
  splitPctA: z.number().int().min(10).max(90).default(50),
  winnerMetric: z.enum(['PROFIT', 'REDEMPTIONS', 'REVENUE']).default('PROFIT'),
  autoWinnerAfterDays: z.number().int().min(0).default(7),
});

export const CampaignTrigger = z.object({
  birthday: z
    .object({
      occasion: z.enum(['BIRTHDAY', 'REGISTRATION_ANNIVERSARY']).default('BIRTHDAY'),
      issueDaysBefore: z.number().int().min(0).max(30).default(3),
      missingDateOfBirth: z.enum(['ASK', 'SKIP']).default('ASK'),
      tierBoost: z
        .object({ enabled: z.boolean().default(true), extraSar: sar.default(10) })
        .optional(),
    })
    .optional(),
});

export const CampaignLoyalty = z.object({
  stampsRequired: z.number().int().min(2).max(50).optional(),
  reward: z.string().max(200).optional(),
  stampExpiryDays: z.number().int().min(1).default(60),
  milestones: z.array(z.string()).default([]),
  minOrderToCountSar: sar.default(30),
  countOrdersFrom: z.enum(['ANY', 'THIS_BRAND', 'THIS_BRANCH']).default('ANY'),
  repeat: z.boolean().default(true),
  progressMessages: z.boolean().default(true),
});

export const CampaignAudience = z.object({
  mode: z.enum(['SEGMENT', 'LIST', 'PHONES', 'ALL']).default('SEGMENT'),
  conditions: z
    .array(z.object({ c: z.enum(AUDIENCE_CONDITIONS), p: z.string().max(200) }))
    .default([]),
  match: z.enum(['ALL', 'ANY']).default('ALL'),
  phoneNumbers: z.array(z.string().regex(/^\+9665\d{8}$/)).default([]),
  listId: z.string().optional(),
  visibility: z.enum(['TARGETED', 'PUBLIC']).default('TARGETED'),
  /** 0-20: a share who do NOT get the coupon, so the extra orders can be measured. */
  controlGroupPct: z.number().int().min(0).max(20).default(10),
  excludeDiscountSensitive: z.boolean().default(true),
});

export const CampaignRules = z.object({
  minOrderSar: sar.default(0),
  maxOrderSar: sar.default(0),
  previousOrders: z.enum(['ANY', 'NONE', 'ONE_PLUS', 'THREE_PLUS']).default('ANY'),
  firstOrderOnly: z.boolean().default(false),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).default([...PAYMENT_METHODS]),
});

export const CampaignScope = z.object({
  brandIds: z.array(z.string()).default([]),
  branchIds: z.array(z.string()).default([]),
  categoryIds: z.array(z.string()).default([]),
  productIds: z.array(z.string()).default([]),
  excludedProductIds: z.array(z.string()).default([]),
  orderTypes: z.array(z.enum(ORDER_TYPES)).min(1).default(['DELIVERY', 'PICKUP', 'CARHOP']),
});

export const CampaignLimits = z.object({
  perCustomerMode: z.enum(['ONE', 'MONTHLY', 'UNLIMITED']).default('ONE'),
  perCustomerMax: z.number().int().min(1).optional(),
  totalRedemptions: z.number().int().min(1),
  dailyRedemptions: z.number().int().min(0).default(0),
  /** The campaign pauses when the discount given reaches it. */
  budgetSar: sar.min(1),
});

export const CampaignDistribution = z.object({
  codeType: z.enum(['NONE', 'SHARED', 'UNIQUE']).default('NONE'),
  code: z.string().max(32).optional(),
  uniqueCodeCount: z.number().int().min(1).optional(),
  channels: z.array(z.enum(CHANNELS)).default(['APP_WALLET', 'PUSH']),
});

export const CampaignStacking = z.object({
  combineWithOtherOffers: z.boolean().default(false),
  combineWithLoyalty: z.boolean().default(true),
  combineWithOtherCoupons: z.boolean().default(false),
});

export const CampaignValidity = z.object({
  startDate: day,
  endDate: day,
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  endTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
});

export const CampaignFunding = z.object({
  source: z.enum(['YIJI_MARKETING', 'BRAND', 'PARTNER', 'SHARED']).default('YIJI_MARKETING'),
  partnerSharePct: pct.default(0),
});

export const CampaignDraft = z.object({
  objective: z.enum(CAMPAIGN_OBJECTIVES),
  name: z.object({ en: z.string().trim().min(1).max(60), ar: z.string().trim().min(1).max(60) }),
  reasonCode: z.string().max(64).optional(),
  funding: CampaignFunding.default({}),
  tenantId: z.string().default('yiji'),
  notes: z.string().max(1000).optional(),
  offer: CampaignOffer,
  experiment: CampaignExperiment.default({}),
  trigger: CampaignTrigger.default({}),
  loyalty: CampaignLoyalty.optional(),
  audience: CampaignAudience.default({}),
  rules: CampaignRules.default({}),
  scope: CampaignScope.default({}),
  limits: CampaignLimits,
  distribution: CampaignDistribution.default({}),
  stacking: CampaignStacking.default({}),
  validity: CampaignValidity,
  /** The pre-study this campaign came from, if any. */
  studyId: z.string().optional(),
});
export type CampaignDraft = z.infer<typeof CampaignDraft>;

/**
 * Once customers hold the coupon these never change (Ayman's "live campaigns"
 * rule). Review 2026-11-16: the lock covers EVERY field that decides what a
 * customer can get or how much it can cost - limits, validity, scope,
 * stacking included - because a live campaign keeps its approval; only the
 * name, notes, reason code and funding stay editable. A bigger budget on a
 * live campaign = end it and approve a new one.
 */
export const LOCKED_WHEN_LIVE: readonly string[] = [
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
  'validity',
  'studyId',
];

export interface CampaignApproval {
  requestedBy: string | null;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

export interface Campaign extends CampaignDraft {
  id: string;
  status: CampaignStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approval: CampaignApproval;
  /** The forecast the business case fixed when it was approved (immutable). */
  snapshot: CampaignForecast | null;
  changeLog: Array<{ at: string; by: string; what: string }>;
}

/* ── money ───────────────────────────────────────────────────────────────── */

/** The company's cost model, versioned by finance (Ayman: `money_model`). */
export interface MoneyModel {
  version: string;
  foodCostPct: number;
  packagingPct: number;
  channelCostPct: Record<OrderType, number>;
  /** Share of recipients who would have ordered anyway (the control group's lesson). */
  wouldOrderAnywayPct: number;
  messageCostSar: Record<(typeof CHANNELS)[number], number>;
  /** Approvals above this cost need a second person (SAR). */
  approvalAboveSar: number;
  /** Discounts above this percentage always need approval. */
  deepDiscountPct: number;
}

export const DEFAULT_MONEY_MODEL: MoneyModel = {
  version: '2026-11',
  foodCostPct: 32,
  packagingPct: 4,
  channelCostPct: { DELIVERY: 18, PICKUP: 3, CARHOP: 5, DINE_IN: 8 },
  wouldOrderAnywayPct: 25,
  messageCostSar: {
    APP_WALLET: 0,
    PUSH: 0,
    SMS: 0.09,
    EMAIL: 0.01,
    WHATSAPP: 0.12,
    IN_APP_BANNER: 0,
  },
  approvalAboveSar: 20_000,
  deepDiscountPct: 50,
};

export interface CampaignForecast {
  customersMatched: number;
  expectedRedemptions: number;
  expectedOrders: number;
  avgOrderSar: number;
  discountSar: number;
  revenueSar: number;
  extraProfitSar: number;
  messageCostSar: number;
  /** extra profit - discount - messages, in SAR. */
  netSar: number;
  /** net / cost, as a percentage. */
  roiPct: number;
  mostItCanCostSar: number;
  needsApproval: boolean;
  approvalReasons: string[];
}

/**
 * The business case, the way the pre-study page computes it: how many will
 * redeem, what that costs, what it brings in beyond the customers who would
 * have ordered anyway. Pure, so the portal shows the same numbers the
 * approval card shows.
 */
export function forecastCampaign(
  draft: Pick<CampaignDraft, 'offer' | 'audience' | 'limits' | 'distribution' | 'scope'>,
  input: {
    customersMatched: number;
    redemptionRatePct: number;
    avgOrderSar: number;
    ordersPerRedeemer?: number;
  },
  model: MoneyModel = DEFAULT_MONEY_MODEL,
): CampaignForecast {
  const reach = Math.round(
    input.customersMatched * (1 - (draft.audience.controlGroupPct ?? 0) / 100),
  );
  const redeemers = Math.round(reach * (input.redemptionRatePct / 100));
  const expectedRedemptions = Math.min(redeemers, draft.limits.totalRedemptions);
  const perOrderDiscount = discountPerOrder(draft.offer, input.avgOrderSar);
  const discountCapped = Math.min(expectedRedemptions * perOrderDiscount, draft.limits.budgetSar);
  const expectedOrders = Math.round(expectedRedemptions * (input.ordersPerRedeemer ?? 1));
  const revenueSar = expectedOrders * input.avgOrderSar;
  const extraOrders = Math.round(expectedOrders * (1 - model.wouldOrderAnywayPct / 100));
  const orderType = draft.scope.orderTypes[0] ?? 'DELIVERY';
  const marginPct = 100 - model.foodCostPct - model.packagingPct - model.channelCostPct[orderType];
  const extraProfitSar = extraOrders * input.avgOrderSar * (marginPct / 100);
  const messageCostSar = draft.distribution.channels.reduce(
    (sum, ch) => sum + reach * (model.messageCostSar[ch] ?? 0),
    0,
  );
  const netSar = extraProfitSar - discountCapped - messageCostSar;
  const cost = discountCapped + messageCostSar;
  const roiPct = cost > 0 ? (netSar / cost) * 100 : 0;
  const mostItCanCostSar = draft.limits.budgetSar + messageCostSar;
  const approvalReasons: string[] = [];
  if (mostItCanCostSar > model.approvalAboveSar) approvalReasons.push('cost_above_threshold');
  if (draft.offer.type === 'PERCENT' && (draft.offer.percent ?? 0) > model.deepDiscountPct)
    approvalReasons.push('deep_discount');
  if (netSar < 0) approvalReasons.push('forecast_loss');
  const r = (n: number) => Math.round(n);
  return {
    customersMatched: input.customersMatched,
    expectedRedemptions,
    expectedOrders,
    avgOrderSar: input.avgOrderSar,
    discountSar: r(discountCapped),
    revenueSar: r(revenueSar),
    extraProfitSar: r(extraProfitSar),
    messageCostSar: r(messageCostSar),
    netSar: r(netSar),
    roiPct: Math.round(roiPct),
    mostItCanCostSar: r(mostItCanCostSar),
    needsApproval: approvalReasons.length > 0,
    approvalReasons,
  };
}

/** What one redemption costs, for an order of `avgOrderSar`. */
export function discountPerOrder(offer: CampaignDraft['offer'], avgOrderSar: number): number {
  switch (offer.type) {
    case 'PERCENT': {
      const raw = (avgOrderSar * (offer.percent ?? 0)) / 100;
      return offer.maxDiscountSar ? Math.min(raw, offer.maxDiscountSar) : raw;
    }
    case 'FIXED':
      return Math.min(offer.amountSar ?? 0, avgOrderSar);
    case 'CASHBACK': {
      const raw = (avgOrderSar * (offer.percent ?? 0)) / 100;
      return offer.maxDiscountSar ? Math.min(raw, offer.maxDiscountSar) : raw;
    }
    case 'FREE_DELIVERY':
      return offer.deliveryFeeCovered === 'FULL' || offer.deliveryFeeCovered === undefined
        ? 12
        : offer.deliveryFeeCovered;
    case 'FREE_ITEM':
      return offer.amountSar ?? 15;
    case 'BXGY':
      return offer.amountSar ?? 20;
    case 'BUNDLE':
      return offer.amountSar ?? 10;
  }
}

/* ── the catalogue of goals (Ayman's 16 coupon types) ────────────────────── */

export interface ObjectiveSpec {
  key: CampaignObjective;
  goal: ObjectiveGoal;
  /** The recommended set-up, pre-filled on step 1. */
  recommended: {
    offer: Partial<z.input<typeof CampaignOffer>> & { type: OfferType };
    minOrderSar: number;
    validityDays: number;
    audience: {
      mode: 'SEGMENT' | 'ALL' | 'LIST';
      conditions: Array<{ c: AudienceCondition; p: string }>;
    };
    channels: Array<(typeof CHANNELS)[number]>;
  };
}

export const OBJECTIVE_CATALOGUE: readonly ObjectiveSpec[] = [
  {
    key: 'NEW_CUSTOMER',
    goal: 'WIN_NEW_AND_LAPSED',
    recommended: {
      offer: { type: 'PERCENT', percent: 40, maxDiscountSar: 25 },
      minOrderSar: 50,
      validityDays: 7,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'REGISTERED_DAYS', p: '30' }] },
      channels: ['APP_WALLET', 'PUSH'],
    },
  },
  {
    key: 'LAPSED_REACTIVATION',
    goal: 'WIN_NEW_AND_LAPSED',
    recommended: {
      offer: { type: 'FIXED', amountSar: 10 },
      minOrderSar: 50,
      validityDays: 7,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'NO_ORDER_DAYS', p: '30' }] },
      channels: ['PUSH', 'SMS'],
    },
  },
  {
    key: 'RETENTION',
    goal: 'KEEP_AND_REWARD',
    recommended: {
      offer: { type: 'CASHBACK', percent: 10, maxDiscountSar: 15 },
      minOrderSar: 40,
      validityDays: 14,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'ORDERED_N_PLUS', p: '4' }] },
      channels: ['APP_WALLET', 'PUSH'],
    },
  },
  {
    key: 'LOYALTY_REWARD',
    goal: 'KEEP_AND_REWARD',
    recommended: {
      offer: { type: 'CASHBACK', percent: 5, maxDiscountSar: 20 },
      minOrderSar: 40,
      validityDays: 14,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'ORDERED_N_PLUS', p: '4' }] },
      channels: ['APP_WALLET'],
    },
  },
  {
    key: 'FREQUENT_ORDER',
    goal: 'KEEP_AND_REWARD',
    recommended: {
      offer: { type: 'FREE_ITEM', amountSar: 28 },
      minOrderSar: 30,
      validityDays: 60,
      audience: { mode: 'ALL', conditions: [] },
      channels: ['APP_WALLET', 'IN_APP_BANNER'],
    },
  },
  {
    key: 'FIRST_ORDER',
    goal: 'WIN_NEW_AND_LAPSED',
    recommended: {
      offer: { type: 'FIXED', amountSar: 15 },
      minOrderSar: 45,
      validityDays: 14,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'ORDERED_ONCE', p: '0' }] },
      channels: ['APP_WALLET', 'PUSH'],
    },
  },
  {
    key: 'REPEAT_PURCHASE',
    goal: 'WIN_NEW_AND_LAPSED',
    recommended: {
      offer: { type: 'FIXED', amountSar: 7 },
      minOrderSar: 40,
      validityDays: 10,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'ORDERED_ONCE', p: '1' }] },
      channels: ['PUSH'],
    },
  },
  {
    key: 'SPECIFIC_ITEM',
    goal: 'GROW_ORDER_VALUE',
    recommended: {
      offer: { type: 'PERCENT', percent: 25, maxDiscountSar: 15 },
      minOrderSar: 0,
      validityDays: 14,
      audience: { mode: 'ALL', conditions: [] },
      channels: ['IN_APP_BANNER', 'PUSH'],
    },
  },
  {
    key: 'MIN_ORDER_VALUE',
    goal: 'GROW_ORDER_VALUE',
    recommended: {
      offer: { type: 'FIXED', amountSar: 10 },
      minOrderSar: 80,
      validityDays: 14,
      audience: { mode: 'ALL', conditions: [] },
      channels: ['APP_WALLET', 'IN_APP_BANNER'],
    },
  },
  {
    key: 'UPSELL',
    goal: 'GROW_ORDER_VALUE',
    recommended: {
      offer: { type: 'BUNDLE', amountSar: 8 },
      minOrderSar: 0,
      validityDays: 14,
      audience: { mode: 'ALL', conditions: [] },
      channels: ['IN_APP_BANNER'],
    },
  },
  {
    key: 'PICKUP',
    goal: 'SHIFT_ORDER_CHANNEL',
    recommended: {
      offer: { type: 'FIXED', amountSar: 5 },
      minOrderSar: 30,
      validityDays: 14,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'ORDER_TYPE', p: 'DELIVERY' }] },
      channels: ['PUSH'],
    },
  },
  {
    key: 'DELIVERY',
    goal: 'SHIFT_ORDER_CHANNEL',
    recommended: {
      offer: { type: 'FREE_DELIVERY', deliveryFeeCovered: 'FULL' },
      minOrderSar: 60,
      validityDays: 14,
      audience: { mode: 'ALL', conditions: [] },
      channels: ['APP_WALLET', 'PUSH'],
    },
  },
  {
    key: 'SLOW_HOURS',
    goal: 'SHIFT_ORDER_CHANNEL',
    recommended: {
      offer: { type: 'PERCENT', percent: 15, maxDiscountSar: 15 },
      minOrderSar: 30,
      validityDays: 30,
      audience: { mode: 'ALL', conditions: [] },
      channels: ['IN_APP_BANNER', 'PUSH'],
    },
  },
  {
    key: 'NEW_BRANCH',
    goal: 'OCCASIONS_AND_RECOVERY',
    recommended: {
      offer: { type: 'PERCENT', percent: 20, maxDiscountSar: 20 },
      minOrderSar: 30,
      validityDays: 21,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'CITY', p: 'Riyadh' }] },
      channels: ['PUSH', 'SMS'],
    },
  },
  {
    key: 'OCCASION',
    goal: 'OCCASIONS_AND_RECOVERY',
    recommended: {
      offer: { type: 'FIXED', amountSar: 15 },
      minOrderSar: 40,
      validityDays: 7,
      audience: { mode: 'SEGMENT', conditions: [{ c: 'BIRTHDAY_MONTH', p: 'this' }] },
      channels: ['APP_WALLET', 'PUSH'],
    },
  },
  {
    key: 'SERVICE_RECOVERY',
    goal: 'OCCASIONS_AND_RECOVERY',
    recommended: {
      offer: { type: 'FIXED', amountSar: 20 },
      minOrderSar: 0,
      validityDays: 30,
      audience: { mode: 'LIST', conditions: [] },
      channels: ['APP_WALLET', 'PUSH'],
    },
  },
];

export function objectiveSpec(key: CampaignObjective): ObjectiveSpec {
  const spec = OBJECTIVE_CATALOGUE.find((o) => o.key === key);
  if (!spec) throw new Error(`unknown objective ${key}`);
  return spec;
}

/* ── the field specification (Ayman's "For IT" page, generated from the form) ─ */

export interface FieldSpec {
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  path: string;
  type:
    | 'enum'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'yesno'
    | 'enum[]'
    | 'productId[]'
    | 'object[]'
    | 'string[]'
    | 'date'
    | 'time';
  required: 'yes' | 'no' | 'conditional';
  default: string;
  /** Shown only for certain offer types / modes. */
  when?: string;
}

export const CAMPAIGN_FIELD_SPEC: readonly FieldSpec[] = [
  {
    step: 1,
    path: 'campaign.objective',
    type: 'enum',
    required: 'yes',
    default: '"REPEAT_PURCHASE"',
  },
  { step: 1, path: 'campaign.name.en', type: 'string', required: 'yes', default: '""' },
  { step: 1, path: 'campaign.name.ar', type: 'string', required: 'yes', default: '""' },
  {
    step: 1,
    path: 'campaign.reasonCode',
    type: 'enum',
    required: 'conditional',
    default: '""',
    when: 'SERVICE_RECOVERY',
  },
  {
    step: 1,
    path: 'campaign.funding.source',
    type: 'enum',
    required: 'no',
    default: '"YIJI_MARKETING"',
  },
  {
    step: 1,
    path: 'campaign.funding.partnerSharePct',
    type: 'number',
    required: 'conditional',
    default: '0',
    when: 'PARTNER | SHARED',
  },
  { step: 1, path: 'campaign.tenantId', type: 'enum', required: 'yes', default: '"yiji"' },
  { step: 1, path: 'campaign.notes', type: 'string', required: 'no', default: '""' },
  { step: 2, path: 'offer.type', type: 'enum', required: 'yes', default: '"FIXED"' },
  {
    step: 2,
    path: 'offer.percent',
    type: 'number',
    required: 'conditional',
    default: '20',
    when: 'PERCENT | CASHBACK',
  },
  {
    step: 2,
    path: 'offer.amountSar',
    type: 'number',
    required: 'conditional',
    default: '7',
    when: 'FIXED',
  },
  {
    step: 2,
    path: 'offer.maxDiscountSar',
    type: 'number',
    required: 'conditional',
    default: '25',
    when: 'PERCENT | CASHBACK',
  },
  {
    step: 2,
    path: 'offer.bxgy.buyQty',
    type: 'number',
    required: 'conditional',
    default: '1',
    when: 'BXGY',
  },
  {
    step: 2,
    path: 'offer.bxgy.getQty',
    type: 'number',
    required: 'conditional',
    default: '1',
    when: 'BXGY',
  },
  {
    step: 2,
    path: 'offer.bxgy.productIds',
    type: 'productId[]',
    required: 'conditional',
    default: '[]',
    when: 'BXGY',
  },
  {
    step: 2,
    path: 'offer.freeItem.productId',
    type: 'string',
    required: 'conditional',
    default: '""',
    when: 'FREE_ITEM',
  },
  {
    step: 2,
    path: 'offer.freeItem.quantity',
    type: 'number',
    required: 'no',
    default: '1',
    when: 'FREE_ITEM',
  },
  {
    step: 2,
    path: 'offer.bundle.productIds',
    type: 'productId[]',
    required: 'conditional',
    default: '[]',
    when: 'BUNDLE',
  },
  {
    step: 2,
    path: 'offer.bundle.priceSar',
    type: 'number',
    required: 'conditional',
    default: '32',
    when: 'BUNDLE',
  },
  {
    step: 2,
    path: 'offer.deliveryFeeCovered',
    type: 'enum',
    required: 'no',
    default: '"FULL"',
    when: 'FREE_DELIVERY',
  },
  {
    step: 2,
    path: 'offer.cashback.creditValidityDays',
    type: 'number',
    required: 'no',
    default: '14',
    when: 'CASHBACK',
  },
  { step: 2, path: 'offer.posDiscountCode', type: 'string', required: 'no', default: '""' },
  { step: 2, path: 'offer.onRefund', type: 'enum', required: 'no', default: '"RETURN_IF_VALID"' },
  {
    step: 2,
    path: 'offer.onCancelBeforeCompletion',
    type: 'enum',
    required: 'no',
    default: '"REISSUE_IF_VALID"',
  },
  {
    step: 2,
    path: 'experiment.enabled',
    type: 'boolean',
    required: 'no',
    default: 'false',
    when: 'PERCENT | FIXED | CASHBACK',
  },
  {
    step: 2,
    path: 'experiment.variantB.value',
    type: 'number',
    required: 'conditional',
    default: '10',
    when: 'experiment',
  },
  {
    step: 2,
    path: 'experiment.splitPctA',
    type: 'integer',
    required: 'no',
    default: '50',
    when: 'experiment',
  },
  {
    step: 2,
    path: 'experiment.winnerMetric',
    type: 'enum',
    required: 'no',
    default: '"PROFIT"',
    when: 'experiment',
  },
  {
    step: 2,
    path: 'experiment.autoWinnerAfterDays',
    type: 'number',
    required: 'no',
    default: '7',
    when: 'experiment',
  },
  {
    step: 2,
    path: 'trigger.birthday.occasion',
    type: 'enum',
    required: 'no',
    default: '"BIRTHDAY"',
    when: 'OCCASION',
  },
  {
    step: 2,
    path: 'trigger.birthday.issueDaysBefore',
    type: 'number',
    required: 'no',
    default: '3',
    when: 'OCCASION',
  },
  {
    step: 2,
    path: 'trigger.birthday.missingDateOfBirth',
    type: 'enum',
    required: 'no',
    default: '"ASK"',
    when: 'OCCASION',
  },
  {
    step: 2,
    path: 'trigger.birthday.tierBoost.enabled',
    type: 'boolean',
    required: 'no',
    default: 'true',
    when: 'OCCASION',
  },
  {
    step: 2,
    path: 'trigger.birthday.tierBoost.extraSar',
    type: 'number',
    required: 'conditional',
    default: '10',
    when: 'OCCASION',
  },
  {
    step: 2,
    path: 'loyalty.stampsRequired',
    type: 'number',
    required: 'conditional',
    default: '5',
    when: 'FREQUENT_ORDER',
  },
  {
    step: 2,
    path: 'loyalty.reward',
    type: 'string',
    required: 'conditional',
    default: '""',
    when: 'FREQUENT_ORDER',
  },
  {
    step: 2,
    path: 'loyalty.stampExpiryDays',
    type: 'number',
    required: 'no',
    default: '60',
    when: 'FREQUENT_ORDER',
  },
  {
    step: 2,
    path: 'loyalty.milestones',
    type: 'enum[]',
    required: 'conditional',
    default: '["5","10","25"]',
    when: 'FREQUENT_ORDER',
  },
  {
    step: 2,
    path: 'loyalty.minOrderToCountSar',
    type: 'number',
    required: 'no',
    default: '30',
    when: 'FREQUENT_ORDER',
  },
  {
    step: 2,
    path: 'loyalty.countOrdersFrom',
    type: 'enum',
    required: 'no',
    default: '"ANY"',
    when: 'FREQUENT_ORDER',
  },
  {
    step: 2,
    path: 'loyalty.repeat',
    type: 'boolean',
    required: 'no',
    default: 'true',
    when: 'FREQUENT_ORDER',
  },
  {
    step: 2,
    path: 'loyalty.progressMessages',
    type: 'boolean',
    required: 'no',
    default: 'true',
    when: 'FREQUENT_ORDER',
  },
  { step: 3, path: 'audience.mode', type: 'enum', required: 'yes', default: '"SEGMENT"' },
  {
    step: 3,
    path: 'audience.conditions[]',
    type: 'object[]',
    required: 'conditional',
    default: '[{"c":"ORDERED_ONCE","p":""}]',
    when: 'SEGMENT',
  },
  {
    step: 3,
    path: 'audience.match',
    type: 'enum',
    required: 'no',
    default: '"ALL"',
    when: 'SEGMENT',
  },
  {
    step: 3,
    path: 'audience.phoneNumbers[]',
    type: 'string[]',
    required: 'conditional',
    default: '[]',
    when: 'PHONES',
  },
  {
    step: 3,
    path: 'audience.listId',
    type: 'string',
    required: 'conditional',
    default: '""',
    when: 'LIST',
  },
  { step: 3, path: 'audience.visibility', type: 'enum', required: 'no', default: '"TARGETED"' },
  { step: 3, path: 'audience.controlGroupPct', type: 'integer', required: 'no', default: '10' },
  {
    step: 3,
    path: 'audience.excludeDiscountSensitive',
    type: 'boolean',
    required: 'no',
    default: 'true',
  },
  { step: 4, path: 'rules.minOrderSar', type: 'number', required: 'yes', default: '50' },
  { step: 4, path: 'rules.maxOrderSar', type: 'number', required: 'no', default: '0' },
  { step: 4, path: 'rules.previousOrders', type: 'enum', required: 'no', default: '"ANY"' },
  { step: 4, path: 'rules.firstOrderOnly', type: 'boolean', required: 'no', default: 'false' },
  {
    step: 4,
    path: 'rules.paymentMethods[]',
    type: 'enum[]',
    required: 'yes',
    default: '["MADA","CARD","APPLE_PAY","CASH","WALLET"]',
  },
  { step: 4, path: 'scope.brandIds[]', type: 'enum[]', required: 'no', default: '[]' },
  { step: 4, path: 'scope.branchIds[]', type: 'enum[]', required: 'no', default: '[]' },
  { step: 4, path: 'scope.categoryIds[]', type: 'enum[]', required: 'no', default: '[]' },
  { step: 4, path: 'scope.productIds[]', type: 'productId[]', required: 'no', default: '[]' },
  {
    step: 4,
    path: 'scope.excludedProductIds[]',
    type: 'productId[]',
    required: 'no',
    default: '[]',
  },
  {
    step: 4,
    path: 'scope.orderTypes[]',
    type: 'enum[]',
    required: 'yes',
    default: '["DELIVERY","PICKUP","CARHOP"]',
  },
  { step: 4, path: 'limits.perCustomerMode', type: 'enum', required: 'no', default: '"ONE"' },
  {
    step: 4,
    path: 'limits.perCustomerMax',
    type: 'number',
    required: 'conditional',
    default: '3',
    when: 'MONTHLY',
  },
  { step: 4, path: 'limits.totalRedemptions', type: 'number', required: 'yes', default: '3000' },
  { step: 4, path: 'limits.dailyRedemptions', type: 'number', required: 'no', default: '0' },
  { step: 4, path: 'limits.budgetSar', type: 'number', required: 'yes', default: '20000' },
  { step: 4, path: 'distribution.codeType', type: 'enum', required: 'no', default: '"NONE"' },
  {
    step: 4,
    path: 'distribution.code',
    type: 'string',
    required: 'conditional',
    default: '""',
    when: 'SHARED',
  },
  {
    step: 4,
    path: 'distribution.uniqueCodeCount',
    type: 'number',
    required: 'conditional',
    default: '5000',
    when: 'UNIQUE',
  },
  {
    step: 4,
    path: 'stacking.combineWithOtherOffers',
    type: 'yesno',
    required: 'no',
    default: 'false',
  },
  { step: 4, path: 'stacking.combineWithLoyalty', type: 'yesno', required: 'no', default: 'true' },
  {
    step: 4,
    path: 'stacking.combineWithOtherCoupons',
    type: 'yesno',
    required: 'no',
    default: 'false',
  },
  {
    step: 4,
    path: 'offer.partialRedemption.enabled',
    type: 'yesno',
    required: 'no',
    default: 'false',
    when: 'FIXED',
  },
  {
    step: 4,
    path: 'offer.partialRedemption.maxPerOrderSar',
    type: 'number',
    required: 'no',
    default: '""',
    when: 'partial',
  },
  {
    step: 4,
    path: 'offer.partialRedemption.balanceExpiry',
    type: 'enum',
    required: 'no',
    default: '"SAME"',
    when: 'partial',
  },
  {
    step: 4,
    path: 'offer.partialRedemption.onOrderCancel',
    type: 'enum',
    required: 'no',
    default: '"RESTORE"',
    when: 'partial',
  },
  { step: 5, path: 'validity.startDate', type: 'date', required: 'yes', default: 'today' },
  {
    step: 5,
    path: 'validity.endDate',
    type: 'date',
    required: 'yes',
    default: 'today + validityDays',
  },
  { step: 5, path: 'validity.startTime', type: 'time', required: 'no', default: '""' },
  { step: 5, path: 'validity.endTime', type: 'time', required: 'no', default: '""' },
  { step: 5, path: 'validity.daysOfWeek[]', type: 'enum[]', required: 'no', default: '[0..6]' },
  {
    step: 6,
    path: 'distribution.channels[]',
    type: 'enum[]',
    required: 'yes',
    default: '["APP_WALLET","PUSH"]',
  },
  {
    step: 7,
    path: 'review.snapshot',
    type: 'object[]',
    required: 'yes',
    default: 'the forecast, fixed on approval',
  },
];

/* ── everything else the portal reads from the engine ───────────────────── */

export interface EngineBrand {
  id: string;
  name: string;
  colour?: string;
}
export interface EngineBranch {
  id: string;
  brandId: string;
  name: string;
  city: string;
}
export interface EngineCategory {
  id: string;
  brandId: string;
  name: string;
}
export interface EngineProduct {
  id: string;
  brandId: string;
  categoryId: string;
  name: string;
  priceSar: number;
  orderTypes: OrderType[];
}
export interface EngineCatalogue {
  brands: EngineBrand[];
  branches: EngineBranch[];
  categories: EngineCategory[];
  products: EngineProduct[];
}

export interface CampaignPerformance {
  campaignId: string;
  issued: number;
  redeemed: number;
  revenueSar: number;
  discountSar: number;
  extraOrders: number;
  extraProfitSar: number;
  roiPct: number;
  controlGroup: { size: number; orderRatePct: number; exposedOrderRatePct: number } | null;
  perDay: Array<{ day: string; issued: number; redeemed: number; revenueSar: number }>;
  /** Plan vs actual: the approved snapshot beside today's numbers. */
  plan: CampaignForecast | null;
}

export interface Redemption {
  id: string;
  campaignId: string;
  customerId: string;
  orderId: string;
  branchId: string;
  amountSar: number;
  at: string;
  reversed: boolean;
}

export interface IssuanceResult {
  batchId: string;
  requested: number;
  issued: number;
  skipped: Array<{ customerId: string; reason: string }>;
}

export interface Liability {
  asOf: string;
  byProduct: Array<{
    product: 'coupons' | 'compensation' | 'gift_cards' | 'points';
    faceValueSar: number;
    atCostSar: number;
    count: number;
  }>;
  totalFaceValueSar: number;
}

export interface GiftCardProduct {
  id: string;
  name: { en: string; ar: string };
  valueSar: number;
  priceSar: number;
  validityDays: number;
  design: { background: string; accent: string; message: string };
  active: boolean;
  canCombineWithCoupons: boolean;
}
export interface GiftCardStats {
  sold: number;
  salesSar: number;
  redeemedSar: number;
  redemptions: number;
  outstandingSar: number;
  activeCards: number;
  unusedCards: number;
  unusedSar: number;
  sentAsGift: number;
  boughtForSelf: number;
  perDay: Array<{ day: string; salesSar: number; redeemedSar: number }>;
  expiringSoon: { cards: number; valueSar: number; withinDays: number };
}
export interface GiftCardActivity {
  id: string;
  at: string;
  kind: 'sold' | 'redeemed' | 'expired' | 'refunded';
  cardId: string;
  amountSar: number;
  customer: string;
}

export interface EarningRule {
  id: string;
  name: string;
  cashbackPct: Record<OrderType, number>;
  brandIds: string[];
  active: boolean;
  validFrom: string;
  validTo: string | null;
}
export interface RewardsCampaign {
  id: string;
  name: string;
  kind: 'ACQUISITION' | 'RETENTION' | 'REACTIVATION';
  points: number;
  budgetPoints: number;
  usedPoints: number;
  active: boolean;
}
export interface RewardsItem {
  id: string;
  name: { en: string; ar: string };
  pointsCost: number;
  costSar: number;
  premium: boolean;
  active: boolean;
  redeemed: number;
}
export interface RewardsStats {
  outstandingPoints: number;
  outstandingSar: number;
  issuedPoints6m: number;
  redeemedPoints6m: number;
  expiredPoints6m: number;
  realCostSar: number;
  activeMembers: number;
  redeemingMembers: number;
  perMonth: Array<{ month: string; issued: number; redeemed: number; expired: number }>;
  expiringSoon: { points: number; customers: number; withinDays: number };
}
export interface RewardsMember {
  customerId: string;
  name: string;
  phone: string;
  tier: 'BRONZE' | 'SILVER' | 'GOLD' | 'VIP';
  points: number;
  earned12m: number;
  redeemed12m: number;
  lastOrderAt: string;
}

export interface OrdersExportRow {
  orderId: string;
  customerId: string;
  placedAt: string;
  brandId: string;
  branchId: string;
  city: string;
  orderType: OrderType;
  totalSar: number;
  items: Array<{ productId: string; qty: number; priceSar: number }>;
  couponCode: string | null;
  completed: boolean;
}

export interface CheckoutSimulation {
  allowed: boolean;
  discountSar: number;
  message: string;
  appliedOrder: Array<'PROMOTIONAL_OFFER' | 'COUPON' | 'LOYALTY' | 'GIFT_CARD'>;
  reason?: string;
}

export interface Study {
  id: string;
  name: string;
  stage: 'draft' | 'finance_review' | 'waiting_approval' | 'approved' | 'running' | 'finished';
  objective: CampaignObjective;
  createdBy: string;
  createdAt: string;
  period: { from: string; to: string };
  data: {
    rowsRead: number;
    completedOrders: number;
    notCompleted: number;
    brands: number;
    cities: number;
    customers: number;
    revenueSar: number;
  };
  scenarios: Array<{
    id: string;
    label: string;
    draft: CampaignDraft;
    input: { customersMatched: number; redemptionRatePct: number; avgOrderSar: number };
    forecast: CampaignForecast;
  }>;
  chosenScenarioId: string | null;
  review: { by: string | null; at: string | null; note: string | null };
  approval: CampaignApproval;
  campaignId: string | null;
}

export interface Opportunity {
  objective: CampaignObjective;
  customersMatched: number;
  expectedReturnPct: number;
  expectedNetSar: number;
  recommendedOfferText: string;
}

export interface CustomerGroup {
  key: 'LOYAL' | 'AT_RISK' | 'LOST' | 'NEW' | 'HIGH_VALUE';
  customers: number;
  share: number;
  goal: CampaignObjective;
}

export interface HomeSummary {
  asOf: string;
  coupons: { live: number; redeemed: number; discountSar: number; waitingApproval: number };
  studies: { total: number; inReview: number; readyToLaunch: number };
  performance: { extraSalesSar: number; roiPct: number; campaignsMeasured: number; alerts: number };
  giftCards: { cards: number; soldSar: number; outstandingSar: number };
  rewards: { activeMembers: number; pointsIssued: number; repeatRatePct: number };
  alerts: Array<{
    id: string;
    area: 'coupons' | 'gift_cards' | 'rewards' | 'performance';
    title: string;
    body: string;
    severity: 'info' | 'warning' | 'danger';
  }>;
}

/** Everything the portal needs. Yiji v2 implements it; the sample engine imitates it. */
export interface MarketingEngine {
  readonly kind: 'sample' | 'live';
  home(): Promise<HomeSummary>;
  catalogue(): Promise<EngineCatalogue>;
  moneyModel(): Promise<MoneyModel>;
  listCampaigns(filter?: {
    status?: CampaignStatus | 'all';
    objective?: CampaignObjective;
  }): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign | null>;
  saveCampaign(draft: CampaignDraft, id?: string): Promise<Campaign>;
  submitForApproval(id: string, forecast: CampaignForecast): Promise<Campaign>;
  decideCampaign(id: string, decision: 'approve' | 'reject', note: string): Promise<Campaign>;
  setCampaignStatus(id: string, status: 'live' | 'paused' | 'ended'): Promise<Campaign>;
  issue(campaignId: string, customerIds: string[]): Promise<IssuanceResult>;
  performance(campaignId: string): Promise<CampaignPerformance>;
  redemptions(campaignId: string, limit?: number): Promise<Redemption[]>;
  liability(): Promise<Liability>;
  giftCardProducts(): Promise<GiftCardProduct[]>;
  saveGiftCardProduct(p: Omit<GiftCardProduct, 'id'>, id?: string): Promise<GiftCardProduct>;
  giftCardStats(range: { from: string; to: string }): Promise<GiftCardStats>;
  giftCardActivity(limit?: number): Promise<GiftCardActivity[]>;
  earningRules(): Promise<EarningRule[]>;
  saveEarningRule(r: Omit<EarningRule, 'id'>, id?: string): Promise<EarningRule>;
  rewardsCampaigns(): Promise<RewardsCampaign[]>;
  rewardsItems(): Promise<RewardsItem[]>;
  rewardsStats(): Promise<RewardsStats>;
  rewardsMembers(query?: string, limit?: number): Promise<RewardsMember[]>;
  ordersExport(range: { from: string; to: string }): Promise<OrdersExportRow[]>;
  simulateCheckout(input: {
    campaignId: string;
    brandId: string;
    orderType: OrderType;
    subtotalSar: number;
    otherOffer: boolean;
    otherCoupon: boolean;
    loyalty: boolean;
  }): Promise<CheckoutSimulation>;
  listStudies(): Promise<Study[]>;
  getStudy(id: string): Promise<Study | null>;
  saveStudy(study: Study): Promise<Study>;
  opportunities(range: { from: string; to: string }): Promise<Opportunity[]>;
  customerGroups(range: { from: string; to: string }): Promise<CustomerGroup[]>;
}

/* ── small helpers the pages share ───────────────────────────────────────── */

export function campaignCode(prefix = 'CMP'): string {
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `${prefix}-${new Date().toISOString().slice(2, 7).replace('-', '')}-${n}`;
}

/** Ayman's rule: the person who created a campaign cannot approve it. */
export function canApproveCampaign(
  c: Pick<Campaign, 'createdBy' | 'status'> & Partial<Pick<Campaign, 'changeLog' | 'approval'>>,
  userId: string,
): { ok: boolean; reason?: 'own' | 'status' } {
  if (c.status !== 'waiting_approval') return { ok: false, reason: 'status' };
  if (c.createdBy === userId) return { ok: false, reason: 'own' };
  /* Four eyes means the decider wrote NONE of it (review 2026-11-16): whoever
     edited or submitted this campaign cannot approve it either. A decision
     they made on an earlier round does not count as writing it. */
  if (c.approval?.requestedBy === userId) return { ok: false, reason: 'own' };
  if (
    (c.changeLog ?? []).some(
      (e) => e.by === userId && /^(created|edited|sent for approval)/.test(e.what),
    )
  )
    return { ok: false, reason: 'own' };
  return { ok: true };
}

export function offerLabel(offer: CampaignDraft['offer']): string {
  switch (offer.type) {
    case 'PERCENT':
      return `${offer.percent ?? 0}% off${offer.maxDiscountSar ? ` up to SAR ${offer.maxDiscountSar}` : ''}`;
    case 'FIXED':
      return `SAR ${offer.amountSar ?? 0} off`;
    case 'CASHBACK':
      return `${offer.percent ?? 0}% cashback${offer.maxDiscountSar ? ` up to SAR ${offer.maxDiscountSar}` : ''}`;
    case 'FREE_DELIVERY':
      return offer.deliveryFeeCovered === 'FULL' || offer.deliveryFeeCovered === undefined
        ? 'Free delivery'
        : `SAR ${offer.deliveryFeeCovered} off delivery`;
    case 'FREE_ITEM':
      return `Free item x${offer.freeItem?.quantity ?? 1}`;
    case 'BXGY':
      return `Buy ${offer.bxgy?.buyQty ?? 1} get ${offer.bxgy?.getQty ?? 1}`;
    case 'BUNDLE':
      return `Bundle at SAR ${offer.bundle?.priceSar ?? 0}`;
  }
}

/* ── the engine's rules, shared by the sample and the CRM's server engine ── */

/** The statuses in which customers may already hold the campaign's coupon. */
export const CAMPAIGN_LOCKED_STATUSES: readonly CampaignStatus[] = ['live', 'paused', 'ended'];

/** One dotted path out of a campaign or draft (`validity.startDate`). */
export function valueAtPath(o: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (x, p) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[p] : undefined),
      o,
    );
}

/**
 * Which LOCKED_WHEN_LIVE paths `next` would change on `prev` - empty when the
 * edit is allowed. Only a campaign customers may already hold is locked.
 */
export function lockedFieldChanges(
  prev: Pick<Campaign, 'status'> & Partial<CampaignDraft>,
  next: Partial<CampaignDraft>,
): string[] {
  if (!CAMPAIGN_LOCKED_STATUSES.includes(prev.status)) return [];
  return LOCKED_WHEN_LIVE.filter(
    (p) => JSON.stringify(valueAtPath(prev, p)) !== JSON.stringify(valueAtPath(next, p)),
  );
}

/**
 * Why a campaign needs a manager, judged by the ENGINE from the draft and the
 * money model - never fewer reasons than the page's own forecast claimed. The
 * cost ceiling is the budget plus the messages; a percentage above the
 * deep-discount line always needs approval; a forecast loss is flagged.
 */
export function campaignApprovalReasons(
  draft: Pick<CampaignDraft, 'offer' | 'limits'>,
  forecast: Pick<CampaignForecast, 'messageCostSar' | 'netSar'> &
    Partial<Pick<CampaignForecast, 'approvalReasons'>>,
  model: MoneyModel = DEFAULT_MONEY_MODEL,
): string[] {
  const reasons = new Set<string>(forecast.approvalReasons ?? []);
  const messages = Math.max(0, Number(forecast.messageCostSar) || 0);
  if (draft.limits.budgetSar + messages > model.approvalAboveSar)
    reasons.add('cost_above_threshold');
  const deep =
    (draft.offer.type === 'PERCENT' || draft.offer.type === 'CASHBACK') &&
    (draft.offer.percent ?? 0) > model.deepDiscountPct;
  if (deep) reasons.add('deep_discount');
  if ((Number(forecast.netSar) || 0) < 0) reasons.add('forecast_loss');
  return [...reasons];
}

/**
 * The checkout rules a coupon is tried against: stacking, minimum order, brand
 * and order type. Pure, so the sample engine and the CRM's engine answer the
 * simulator the same way.
 */
export function simulateCampaignCheckout(
  c: Pick<Campaign, 'offer' | 'rules' | 'scope' | 'stacking'> | null,
  input: {
    brandId: string;
    orderType: OrderType;
    subtotalSar: number;
    otherOffer: boolean;
    otherCoupon: boolean;
    loyalty: boolean;
  },
): CheckoutSimulation {
  if (!c)
    return {
      allowed: false,
      discountSar: 0,
      message: 'Unknown coupon.',
      appliedOrder: [],
      reason: 'unknown',
    };
  const order: CheckoutSimulation['appliedOrder'] = [];
  const refuse = (message: string, reason: string): CheckoutSimulation => ({
    allowed: false,
    discountSar: 0,
    message,
    appliedOrder: order,
    reason,
  });
  if (input.otherOffer) order.push('PROMOTIONAL_OFFER');
  if (input.otherOffer && !c.stacking.combineWithOtherOffers)
    return refuse('This coupon cannot be used with the offer in the cart.', 'stacking_offer');
  if (input.otherCoupon && !c.stacking.combineWithOtherCoupons)
    return refuse('One coupon per order.', 'stacking_coupon');
  if (input.subtotalSar < c.rules.minOrderSar)
    return refuse(`Minimum order SAR ${c.rules.minOrderSar}.`, 'min_order');
  if (c.scope.brandIds.length && !c.scope.brandIds.includes(input.brandId))
    return refuse('Not valid for this brand.', 'scope_brand');
  if (!c.scope.orderTypes.includes(input.orderType))
    return refuse('Not valid for this order type.', 'scope_order_type');
  const discountSar = Math.round(discountPerOrder(c.offer, input.subtotalSar) * 100) / 100;
  order.push('COUPON');
  if (input.loyalty) order.push(c.stacking.combineWithLoyalty ? 'LOYALTY' : 'COUPON');
  return {
    allowed: true,
    discountSar,
    message: `SAR ${discountSar} off applied.`,
    appliedOrder: order,
  };
}
