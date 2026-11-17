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
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/*
 * FIELD PARITY WITH THE DESIGN (owner, 2026-11-17). The schema below is the
 * owner-approved draft's field list (docs/marketing/ayman-draft-fields.csv,
 * 107 rows) field by field; docs/marketing/field-parity.md maps every row to
 * the code. Each field carries the draft's type, its required/conditional
 * rule (in `campaignDraftIssues`, below) and its options and ranges. Rows
 * stored before the parity work are read through `upgradeCampaignDraft`, so
 * nothing already saved stops opening.
 */

export const LOYALTY_TYPES = ['STAMP', 'CHALLENGE', 'MILESTONE'] as const;
export const LOYALTY_MILESTONES = ['5', '10', '25', '50', '100'] as const;
export const ADD_MODES = ['AUTO_WALLET', 'CUSTOMER_CLAIMS'] as const;
export const ISSUE_MODES = ['ALL_AT_ONCE', 'WHEN_ELIGIBLE'] as const;
export const SEND_TIMES = ['ON_ISSUE', 'ON_START_DATE', 'BEST_TIME'] as const;
export const FREQUENCY_CAPS = [
  'ONE_PER_DAY',
  'THREE_PER_WEEK',
  'ONE_PER_WEEK',
  'NO_LIMIT',
] as const;
export const COMPENSATION_REASONS = [
  'LATE_ORDER',
  'MISSING_ITEM',
  'QUALITY',
  'DRIVER',
  'APP_ISSUE',
] as const;
export const FUNDING_SOURCES = ['YIJI_MARKETING', 'BRAND', 'PARTNER', 'SHARED'] as const;
/** The tenants a campaign can belong to (the current screen's single tenant). */
export const CAMPAIGN_TENANTS = ['yiji'] as const;

/** A card's first 6-8 digits (BIN), or a range of two BINs of the same length. */
export const BIN_RANGE = /^(\d{6,8})(?:-(\d{6,8}))?$/;

export const CampaignOffer = z.object({
  type: z.enum(OFFER_TYPES),
  /** 1-100: PERCENT and CASHBACK. */
  percent: z.number().min(1).max(100).optional(),
  /** Greater than 0: FIXED (and the cost estimate of the item offers). */
  amountSar: z.number().gt(0).optional(),
  /** Caps the saving on large orders; mandatory for PERCENT and CASHBACK. */
  maxDiscountSar: z.number().gt(0).optional(),
  bxgy: z
    .object({
      buyQty: z.number().int().min(1),
      getQty: z.number().int().min(1),
      /** The menu product; the free one is the same or a cheaper one. */
      productId: z.string().max(64),
    })
    .optional(),
  freeItem: z
    .object({ productId: z.string().max(64), quantity: z.number().int().min(1).default(1) })
    .optional(),
  bundle: z
    .object({ productIds: z.array(z.string().max(64)).min(2), priceSar: z.number().gt(0) })
    .optional(),
  /** FULL, or a SAR amount of the delivery fee covered. */
  deliveryFeeCoveredSar: z.union([z.literal('FULL'), z.number().gt(0)]).optional(),
  cashback: z.object({ creditValidityDays: z.number().int().min(1).max(365) }).optional(),
  /** Matches the discount line in the restaurant POS. */
  posDiscountCode: z.string().max(64).optional(),
  onRefund: z.enum(['RETURN_IF_VALID', 'KEEP', 'NEVER_RETURN']).default('RETURN_IF_VALID'),
  onCancelBeforeCompletion: z
    .enum(['REISSUE_IF_VALID', 'KEEP', 'NEVER_RETURN'])
    .default('REISSUE_IF_VALID'),
  partialRedemption: z
    .object({
      enabled: z.boolean().default(false),
      maxPerOrderSar: z.number().gt(0).optional(),
      balanceExpiry: z.enum(['SAME', 'DAYS_30', 'DAYS_90']).default('SAME'),
      onOrderCancel: z.enum(['RESTORE', 'KEEP']).default('RESTORE'),
    })
    .optional(),
});

export const CampaignExperiment = z.object({
  enabled: z.boolean().default(false),
  variantB: z.object({ value: z.number().gt(0) }).optional(),
  /** 10-90: the share who get version A; the rest get version B. */
  splitPctA: z.number().int().min(10).max(90).default(50),
  winnerMetric: z.enum(['PROFIT', 'REDEMPTIONS', 'REVENUE']).default('PROFIT'),
  autoWinnerAfterDays: z.number().int().min(0).max(90).default(7),
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
  /** How customers earn the reward. */
  type: z.enum(LOYALTY_TYPES),
  /** STAMP and CHALLENGE: orders per card. */
  ordersRequired: z.number().int().min(2).max(50).optional(),
  /** CHALLENGE: the orders must fall within this many days. */
  windowDays: z.number().int().min(1).max(365).optional(),
  stampExpiryDays: z.number().int().min(1).max(365).default(60),
  /** MILESTONE: the lifetime order numbers that earn the reward. */
  milestones: z.array(z.enum(LOYALTY_MILESTONES)).default([]),
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
  /** Code-only (kept): how the conditions combine - ALL (AND) or ANY (OR). */
  match: z.enum(['ALL', 'ANY']).default('ALL'),
  phoneNumbers: z.array(z.string().regex(/^\+9665\d{8}$/)).default([]),
  /** Code-only (kept): the saved list a LIST audience uses. */
  listId: z.string().max(80).optional(),
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
  paymentMethods: z
    .array(z.enum(PAYMENT_METHODS))
    .min(1)
    .default([...PAYMENT_METHODS]),
  /** Partner offers: the bank cards (BIN or BIN-BIN range) the coupon is limited to. */
  binRanges: z.array(z.string().regex(BIN_RANGE)).max(50).default([]),
});

export const CampaignScope = z.object({
  /** Every brand and branch, including ones opened later. */
  allBrands: z.boolean().default(true),
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
  uniqueCodeCount: z.number().int().min(1).max(1_000_000).optional(),
  channels: z.array(z.enum(CHANNELS)).min(1).default(['APP_WALLET', 'PUSH']),
  /** AUTO_WALLET: added to the wallet; CUSTOMER_CLAIMS: the customer claims it. */
  addMode: z.enum(ADD_MODES).default('AUTO_WALLET'),
  /** ALL_AT_ONCE: one batch to the audience; WHEN_ELIGIBLE: each customer when they qualify. */
  issueMode: z.enum(ISSUE_MODES).default('ALL_AT_ONCE'),
});

export const CampaignStacking = z.object({
  combineWithOtherOffers: z.boolean().default(false),
  combineWithLoyalty: z.boolean().default(true),
  combineWithOtherCoupons: z.boolean().default(false),
});

export const CampaignFraud = z.object({
  /** Mandatory for first-order and new-customer coupons. */
  onePerPhoneAndDevice: z.boolean().default(false),
  excludeStaffAndTestAccounts: z.boolean().default(false),
  blockFlaggedCustomers: z.boolean().default(false),
});

/** When the coupon can be used (the draft's `schedule`; was `validity`). */
export const CampaignSchedule = z.object({
  startDate: day,
  endDate: day,
  allDay: z.boolean().default(true),
  timeWindow: z.object({ from: hhmm.optional(), to: hhmm.optional() }).default({}),
  onlyDuringBranchHours: z.boolean().default(false),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).default([0, 1, 2, 3, 4, 5, 6]),
  /** The customer's coupon expires this many days after it is issued. */
  expiresAfterIssueDays: z.number().int().min(1).max(365),
  /** A flash offer: once issued, it must be used within `hours`. */
  limitedTime: z
    .object({
      enabled: z.boolean().default(false),
      hours: z.number().int().min(1).max(168).optional(),
    })
    .default({}),
});

const bilingual = (max: number) =>
  z
    .object({
      en: z.string().trim().max(max).default(''),
      ar: z.string().trim().max(max).default(''),
    })
    .default({});

/** What the customer is told, per channel (step 6). */
export const CampaignCommunication = z.object({
  push: z.object({ title: bilingual(65), body: bilingual(240) }).default({}),
  banner: z.object({ text: bilingual(80) }).default({}),
  sms: z.object({ text: bilingual(320) }).default({}),
  sendTime: z.enum(SEND_TIMES).default('ON_ISSUE'),
  /** Shared across campaigns; enforced by the notification service. */
  frequencyCap: z.enum(FREQUENCY_CAPS).default('THREE_PER_WEEK'),
  /** No messages between 23:00 and 09:00. */
  quietHours: z.boolean().default(true),
  /** PDPL: must stay on for SMS and email. */
  respectConsent: z.boolean().default(true),
});

/** Planning inputs for the business case (step 7); empty = estimated. */
export const CampaignForecastPlan = z.object({
  baselineOrderRatePct: pct.optional(),
  expectedUpliftPts: pct.optional(),
});

export const CampaignFunding = z.object({
  source: z.enum(FUNDING_SOURCES).default('YIJI_MARKETING'),
  partnerSharePct: pct.default(0),
});

/** The draft's fields, without the cross-field rules (read old rows with this). */
export const CampaignDraftShape = z.object({
  objective: z.enum(CAMPAIGN_OBJECTIVES),
  name: z.object({ en: z.string().trim().min(1).max(60), ar: z.string().trim().min(1).max(60) }),
  reasonCode: z.string().max(64).optional(),
  funding: CampaignFunding.default({}),
  tenantId: z.string().min(1).max(40).default('yiji'),
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
  fraud: CampaignFraud.default({}),
  schedule: CampaignSchedule,
  communication: CampaignCommunication.default({}),
  forecast: CampaignForecastPlan.default({}),
  /** The pre-study this campaign came from, if any. */
  studyId: z.string().optional(),
});
type DraftShape = z.infer<typeof CampaignDraftShape>;

/** Objectives (and rules) whose coupon is only for a customer's first order. */
export function firstOrderCoupon(
  d: Pick<DraftShape, 'objective'> & { rules?: { firstOrderOnly?: boolean } },
): boolean {
  return (
    d.objective === 'FIRST_ORDER' || d.objective === 'NEW_CUSTOMER' || !!d.rules?.firstOrderOnly
  );
}

/** Inclusive days from `from` to `to` (yyyy-mm-dd), or null when unreadable. */
export function inclusiveDays(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * The draft's required/conditional rules, as path + message. Pure: the form,
 * the sample engine and the CRM's engine refuse the same drafts.
 */
export function campaignDraftIssues(d: DraftShape): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  const add = (path: string, message: string) => out.push({ path, message });
  const o = d.offer;
  const pctOffer = o.type === 'PERCENT' || o.type === 'CASHBACK';
  /* step 1 */
  if (d.objective === 'SERVICE_RECOVERY' && !d.reasonCode)
    add('reasonCode', 'Required for compensation.');
  if (
    (d.funding.source === 'PARTNER' || d.funding.source === 'SHARED') &&
    !(d.funding.partnerSharePct > 0)
  )
    add('funding.partnerSharePct', 'Say how much the partner pays.');
  /* step 2 - the discount */
  if (pctOffer && o.percent === undefined) add('offer.percent', 'Required: 1-100.');
  if (pctOffer && o.maxDiscountSar === undefined)
    add('offer.maxDiscountSar', 'Mandatory for percentage and cashback.');
  if (o.type === 'FIXED' && o.amountSar === undefined)
    add('offer.amountSar', 'Required: greater than 0.');
  if (o.type === 'BXGY' && !o.bxgy?.productId) add('offer.bxgy.productId', 'Pick the item.');
  if (o.type === 'FREE_ITEM' && !o.freeItem?.productId)
    add('offer.freeItem.productId', 'Pick the free item.');
  if (o.type === 'BUNDLE' && !o.bundle) add('offer.bundle.productIds', 'At least 2 menu items.');
  if (o.partialRedemption?.enabled && o.type !== 'FIXED')
    add('offer.partialRedemption.enabled', 'Fixed-amount coupons only.');
  if (d.experiment.enabled) {
    if (!(o.type === 'PERCENT' || o.type === 'FIXED' || o.type === 'CASHBACK'))
      add('experiment.enabled', 'Only for percentage, fixed amount and cashback.');
    if (!d.experiment.variantB) add('experiment.variantB.value', 'Required for a test.');
    else if (pctOffer && d.experiment.variantB.value > 100)
      add('experiment.variantB.value', 'A percentage: 1-100.');
  }
  const boost = d.trigger.birthday?.tierBoost;
  if (boost?.enabled && !(boost.extraSar > 0))
    add('trigger.birthday.tierBoost.extraSar', 'Required: greater than 0.');
  if (d.objective === 'FREQUENT_ORDER' && !d.loyalty)
    add('loyalty.type', 'Say how customers earn the reward.');
  if (d.loyalty) {
    const l = d.loyalty;
    if ((l.type === 'STAMP' || l.type === 'CHALLENGE') && l.ordersRequired === undefined)
      add('loyalty.ordersRequired', 'Required: 2-50 orders.');
    if (l.type === 'CHALLENGE' && l.windowDays === undefined)
      add('loyalty.windowDays', 'Required: the days the orders must fall within.');
    if (l.type === 'MILESTONE' && l.milestones.length === 0)
      add('loyalty.milestones', 'Pick at least one order number.');
  }
  /* step 3 - customers */
  if (d.audience.mode === 'SEGMENT' && d.audience.conditions.length === 0)
    add('audience.conditions', 'Add at least one condition.');
  if (d.audience.mode === 'PHONES' && d.audience.phoneNumbers.length === 0)
    add('audience.phoneNumbers', 'Add the phone numbers.');
  if (d.audience.mode === 'LIST' && !d.audience.listId) add('audience.listId', 'Pick the list.');
  /* step 4 - eligibility */
  if (!d.scope.allBrands && d.scope.brandIds.length === 0)
    add('scope.brandIds', 'Pick at least one brand, or all brands.');
  if (d.scope.allBrands && d.scope.brandIds.length > 0)
    add('scope.allBrands', 'All brands, or a list of brands - not both.');
  if (d.limits.perCustomerMode === 'MONTHLY' && d.limits.perCustomerMax === undefined)
    add('limits.perCustomerMax', 'Required for a monthly limit.');
  if (d.distribution.codeType === 'SHARED' && !d.distribution.code?.trim())
    add('distribution.code', 'Type the shared code.');
  if (d.distribution.codeType === 'UNIQUE' && d.distribution.uniqueCodeCount === undefined)
    add('distribution.uniqueCodeCount', 'Say how many codes.');
  for (const [i, r] of d.rules.binRanges.entries()) {
    const m = BIN_RANGE.exec(r);
    if (m?.[2] && (m[2].length !== m[1]!.length || m[2] < m[1]!))
      add(`rules.binRanges.${i}`, 'A range is two BINs of the same length, low to high.');
  }
  if (firstOrderCoupon(d) && !d.fraud.onePerPhoneAndDevice)
    add('fraud.onePerPhoneAndDevice', 'Mandatory for first-order and new-customer coupons.');
  /* step 5 - schedule */
  const s = d.schedule;
  if (s.endDate < s.startDate) add('schedule.endDate', 'On or after the start date.');
  const { from, to } = s.timeWindow;
  if (s.allDay && (from || to)) add('schedule.allDay', 'All day, or a time window - not both.');
  if (!s.allDay && !s.onlyDuringBranchHours && !(from && to))
    add('schedule.timeWindow.from', 'Set the start and end time, or choose all day.');
  if ((from && !to) || (!from && to))
    add(from ? 'schedule.timeWindow.to' : 'schedule.timeWindow.from', 'Both times, or neither.');
  if (from && to && from === to) add('schedule.timeWindow.to', 'Must differ from the start time.');
  if (s.limitedTime.enabled && s.limitedTime.hours === undefined)
    add('schedule.limitedTime.hours', 'Required for a flash offer.');
  /* step 6 - distribution */
  const ch = d.distribution.channels;
  const c = d.communication;
  const both = (path: string, v: { en: string; ar: string }) => {
    if (!v.en.trim()) add(`${path}.en`, 'Required for this channel.');
    if (!v.ar.trim()) add(`${path}.ar`, 'Required for this channel.');
  };
  if (ch.includes('PUSH')) {
    both('communication.push.title', c.push.title);
    both('communication.push.body', c.push.body);
  }
  if (ch.includes('IN_APP_BANNER')) both('communication.banner.text', c.banner.text);
  if (ch.includes('SMS')) both('communication.sms.text', c.sms.text);
  if ((ch.includes('SMS') || ch.includes('EMAIL')) && !c.respectConsent)
    add('communication.respectConsent', 'Must stay on for SMS and email (PDPL).');
  return out;
}

/** The campaign draft, with the design's required and conditional rules. */
export const CampaignDraft = CampaignDraftShape.superRefine((d, ctx) => {
  for (const i of campaignDraftIssues(d))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: i.path.split('.'), message: i.message });
});
export type CampaignDraft = z.infer<typeof CampaignDraft>;

/**
 * The paths renamed by the field-parity work: the old (stored) path -> the
 * draft's path. Old rows are rewritten on read by `upgradeCampaignDraft`.
 */
export const CAMPAIGN_FIELD_RENAMES: Readonly<Record<string, string>> = {
  'validity.startDate': 'schedule.startDate',
  'validity.endDate': 'schedule.endDate',
  'validity.startTime': 'schedule.timeWindow.from',
  'validity.endTime': 'schedule.timeWindow.to',
  'validity.daysOfWeek[]': 'schedule.daysOfWeek[]',
  'offer.bxgy.productIds': 'offer.bxgy.productId',
  'offer.bundle.productIds': 'offer.bundle.productIds[]',
  'offer.deliveryFeeCovered': 'offer.deliveryFeeCoveredSar',
  'loyalty.stampsRequired': 'loyalty.ordersRequired',
  'loyalty.milestones': 'loyalty.milestones[]',
};

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A stored draft in the shape before field parity -> today's shape. Pure and
 * total: it never throws and leaves anything it does not recognise alone, so
 * a row written by any earlier build still opens. Idempotent.
 *
 *   validity.{startDate,endDate,daysOfWeek} -> schedule.*
 *   validity.startTime/endTime -> schedule.timeWindow.from/to (allDay = false)
 *   (no expiry)                -> schedule.expiresAfterIssueDays = the window's days
 *   offer.bxgy.productIds[0]   -> offer.bxgy.productId
 *   offer.deliveryFeeCovered   -> offer.deliveryFeeCoveredSar
 *   loyalty.stampsRequired     -> loyalty.type STAMP + loyalty.ordersRequired
 *   loyalty.reward (text)      -> appended to notes (the field is gone)
 *   (no scope.allBrands)       -> true when no brand is listed
 *   (no fraud)                 -> one per phone and device for first-order coupons
 */
export function upgradeCampaignDraft(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const d: Loose = { ...raw };
  if (isObj(d.validity) && !isObj(d.schedule)) {
    const { startTime, endTime, ...rest } = d.validity;
    const window: Loose = {};
    if (typeof startTime === 'string' && startTime) window.from = startTime;
    if (typeof endTime === 'string' && endTime) window.to = endTime;
    const schedule: Loose = {
      ...rest,
      allDay: Object.keys(window).length === 0,
      timeWindow: window,
    };
    const days =
      typeof rest.startDate === 'string' && typeof rest.endDate === 'string'
        ? inclusiveDays(rest.startDate, rest.endDate)
        : null;
    if (days !== null) schedule.expiresAfterIssueDays = Math.min(365, Math.max(1, days));
    d.schedule = schedule;
  }
  delete d.validity;
  if (isObj(d.offer)) {
    const offer: Loose = { ...d.offer };
    if (isObj(offer.bxgy) && offer.bxgy.productId === undefined) {
      const { productIds, ...bxgy } = offer.bxgy;
      const first = Array.isArray(productIds) ? productIds[0] : undefined;
      offer.bxgy = { ...bxgy, productId: typeof first === 'string' ? first : '' };
    }
    if (offer.deliveryFeeCovered !== undefined) {
      if (offer.deliveryFeeCoveredSar === undefined)
        offer.deliveryFeeCoveredSar = offer.deliveryFeeCovered;
      delete offer.deliveryFeeCovered;
    }
    d.offer = offer;
  }
  if (isObj(d.loyalty)) {
    const { stampsRequired, reward, ...loyalty } = d.loyalty;
    if (loyalty.type === undefined) {
      if (typeof stampsRequired === 'number') {
        loyalty.type = 'STAMP';
        loyalty.ordersRequired = stampsRequired;
      } else if (Array.isArray(loyalty.milestones) && loyalty.milestones.length) {
        loyalty.type = 'MILESTONE';
      }
    }
    if (typeof reward === 'string' && reward.trim()) {
      const note = `Loyalty reward: ${reward.trim()}`;
      const notes = typeof d.notes === 'string' && d.notes ? `${d.notes}\n${note}` : note;
      d.notes = notes.slice(0, 1000);
    }
    /* A loyalty block with no way to earn was never a programme: drop it. */
    if (loyalty.type === undefined) delete d.loyalty;
    else d.loyalty = loyalty;
  }
  if (isObj(d.scope) && d.scope.allBrands === undefined) {
    const ids = d.scope.brandIds;
    d.scope = { ...d.scope, allBrands: !(Array.isArray(ids) && ids.length > 0) };
  }
  if (d.fraud === undefined && typeof d.objective === 'string') {
    const rules = isObj(d.rules) ? d.rules : {};
    if (
      firstOrderCoupon({
        objective: d.objective as DraftShape['objective'],
        rules: { firstOrderOnly: rules.firstOrderOnly === true },
      })
    )
      d.fraud = { onePerPhoneAndDevice: true };
  }
  return d;
}

/** Accepts today's shape or any earlier one (an older portal, a stored row). */
export const StoredCampaignDraft = z.preprocess(upgradeCampaignDraft, CampaignDraft);

/**
 * A stored draft for READING: upgraded, then each section given its defaults.
 * Never refuses - a section that does not validate is kept as stored - because
 * a row that once saved must keep opening (the engine re-checks it on save).
 */
export function readCampaignDraft(raw: unknown): CampaignDraft {
  const up = upgradeCampaignDraft(raw);
  return lenient(CampaignDraftShape, isObj(up) ? up : {}) as CampaignDraft;
}

/** `schema` applied field by field: what validates gets its defaults, the rest stays as is. */
function lenient(schema: z.ZodTypeAny, v: unknown): unknown {
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  let inner: z.ZodTypeAny = schema;
  while (inner instanceof z.ZodDefault || inner instanceof z.ZodOptional)
    inner = inner._def.innerType as z.ZodTypeAny;
  if (!(inner instanceof z.ZodObject) || !isObj(v)) return v;
  const out: Loose = { ...v };
  for (const [k, s] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
    const x = lenient(s, v[k]);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

/**
 * The fields that must be unique: the English name among the campaigns that
 * are not over, and a shared code among those customers may hold or soon will.
 */
export function campaignUniquenessConflicts(
  draft: Pick<CampaignDraft, 'name' | 'distribution'>,
  id: string | undefined,
  others: ReadonlyArray<Pick<Campaign, 'id' | 'status' | 'name' | 'distribution'>>,
): string[] {
  const out: string[] = [];
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  const rest = others.filter((c) => c.id !== id && c.status !== 'ended' && c.status !== 'rejected');
  if (rest.some((c) => norm(c.name?.en) === norm(draft.name.en))) out.push('campaign.name.en');
  const code = draft.distribution.codeType === 'SHARED' ? norm(draft.distribution.code) : '';
  if (
    code &&
    rest.some(
      (c) =>
        CODE_HOLDING_STATUSES.includes(c.status) &&
        c.distribution?.codeType === 'SHARED' &&
        norm(c.distribution.code) === code,
    )
  )
    out.push('distribution.code');
  return out;
}

/** Statuses in which a shared code is taken: approved, about to be or already live. */
const CODE_HOLDING_STATUSES: readonly CampaignStatus[] = [
  'waiting_approval',
  'approved',
  'live',
  'paused',
];

/**
 * Once customers hold the coupon these never change (Ayman's "live campaigns"
 * rule). Review 2026-11-16: the lock covers EVERY field that decides what a
 * customer can get or how much it can cost - limits, schedule, scope,
 * stacking, fraud rules and what customers are told included - because a live
 * campaign keeps its approval; only the name, notes, reason code and funding
 * stay editable. A bigger budget on a live campaign = end it and approve a
 * new one.
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
  'fraud',
  'schedule',
  'communication',
  'forecast',
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
  draft: Pick<CampaignDraft, 'offer' | 'audience' | 'limits' | 'distribution' | 'scope'> &
    Partial<Pick<CampaignDraft, 'forecast'>>,
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
  const extraOrders = Math.round(
    expectedOrders * (1 - wouldOrderAnywayPct(draft.forecast, model) / 100),
  );
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

/**
 * The share of redeemers who would have ordered anyway (%). The draft's
 * planning inputs (step 7) decide it when both are given: of the customers
 * who order, `baseline` would have anyway and `uplift` more come because of
 * the coupon. Empty = the money model's estimate.
 */
export function wouldOrderAnywayPct(
  plan: Partial<CampaignDraft['forecast']> | undefined,
  model: Pick<MoneyModel, 'wouldOrderAnywayPct'> = DEFAULT_MONEY_MODEL,
): number {
  const b = plan?.baselineOrderRatePct;
  const u = plan?.expectedUpliftPts;
  if (b === undefined || u === undefined || b + u <= 0) return model.wouldOrderAnywayPct;
  return (b / (b + u)) * 100;
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
      return offer.deliveryFeeCoveredSar === 'FULL' || offer.deliveryFeeCoveredSar === undefined
        ? 12
        : offer.deliveryFeeCoveredSar;
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
      offer: { type: 'FREE_DELIVERY', deliveryFeeCoveredSar: 'FULL' },
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

/** The draft's own field types (docs/marketing/ayman-draft-fields.csv, column `type`). */
export type FieldSpecType =
  | 'objective'
  | 'text'
  | 'textarea'
  | 'select'
  | 'cards'
  | 'multicards'
  | 'radio'
  | 'number'
  | 'range'
  | 'bool'
  | 'yesno'
  | 'multi'
  | 'rules'
  | 'itemselect'
  | 'itempicker'
  | 'date'
  | 'time';

export interface FieldSpec {
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** The i18n key under `promo.field.` (path without `campaign.` and `[]`, dots -> `_`). */
  key: string;
  /** The draft's English label. */
  label: string;
  /** The draft's api_path. */
  path: string;
  type: FieldSpecType;
  required: 'yes' | 'no' | 'conditional';
  default: string;
  /** Shown only for certain offer types / modes. */
  when?: string;
  /** The draft's notes (options, ranges, what it replaced). */
  notes: string;
}

/**
 * EXACTLY the design's 107 rows, in its order (owner, 2026-11-17: "match the
 * approved design field by field"). The round-trip test sets every path and
 * reads it back from the Directus row; a test also pins each row to the CSV.
 */
export const CAMPAIGN_FIELD_SPEC: readonly FieldSpec[] = [
  {
    step: 1,
    key: 'objective',
    label: 'Coupon objective',
    path: 'campaign.objective',
    type: 'objective',
    required: 'yes',
    default: '"REPEAT_PURCHASE"',
    notes: '15 objectives; each maps to a catalogue type (C01–C25) and pre-fills defaults',
  },
  {
    step: 1,
    key: 'name_en',
    label: 'Campaign name (English)',
    path: 'campaign.name.en',
    type: 'text',
    required: 'yes',
    default: '""',
    notes: 'Unique; max 60 characters. Was “Title”.',
  },
  {
    step: 1,
    key: 'name_ar',
    label: 'Campaign name (Arabic)',
    path: 'campaign.name.ar',
    type: 'text',
    required: 'yes',
    default: '""',
    notes: 'Required; shown in the Arabic app',
  },
  {
    step: 1,
    key: 'reasonCode',
    label: 'Compensation reason',
    path: 'campaign.reasonCode',
    type: 'select',
    required: 'conditional',
    default: '""',
    when: 'SERVICE_RECOVERY',
    notes: 'Required for compensation; kept for audit. Was “compensation”.',
  },
  {
    step: 1,
    key: 'funding_source',
    label: 'Who pays for the discount',
    path: 'campaign.funding.source',
    type: 'select',
    required: 'no',
    default: '"YIJI_MARKETING"',
    notes: 'Was “Issuing Side”',
  },
  {
    step: 1,
    key: 'funding_partnerSharePct',
    label: 'Partner pays',
    path: 'campaign.funding.partnerSharePct',
    type: 'number',
    required: 'conditional',
    default: '0',
    when: 'PARTNER | SHARED',
    notes: 'Recorded for reconciliation with the partner',
  },
  {
    step: 1,
    key: 'tenantId',
    label: 'Tenant',
    path: 'campaign.tenantId',
    type: 'select',
    required: 'yes',
    default: '"yiji"',
    notes: 'Kept from the current screen',
  },
  {
    step: 1,
    key: 'notes',
    label: 'Internal note (optional)',
    path: 'campaign.notes',
    type: 'textarea',
    required: 'no',
    default: '""',
    notes: '',
  },
  {
    step: 2,
    key: 'offer_type',
    label: 'Discount type',
    path: 'offer.type',
    type: 'cards',
    required: 'yes',
    default: '"FIXED"',
    notes: 'PERCENT, FIXED, BXGY, FREE_ITEM, BUNDLE, FREE_DELIVERY, CASHBACK. Was “Coupon Types”.',
  },
  {
    step: 2,
    key: 'offer_percent',
    label: 'Discount percentage',
    path: 'offer.percent',
    type: 'number',
    required: 'conditional',
    default: '20',
    when: 'PERCENT | CASHBACK',
    notes: '1–100',
  },
  {
    step: 2,
    key: 'offer_amountSar',
    label: 'Discount amount',
    path: 'offer.amountSar',
    type: 'number',
    required: 'conditional',
    default: '7',
    when: 'FIXED',
    notes: 'Greater than 0',
  },
  {
    step: 2,
    key: 'offer_maxDiscountSar',
    label: 'Maximum discount',
    path: 'offer.maxDiscountSar',
    type: 'number',
    required: 'conditional',
    default: '25',
    when: 'PERCENT | CASHBACK',
    notes: 'Mandatory for percentage and cashback. Was “Maximum Discount”.',
  },
  {
    step: 2,
    key: 'offer_bxgy_buyQty',
    label: 'Customer buys',
    path: 'offer.bxgy.buyQty',
    type: 'number',
    required: 'conditional',
    default: '1',
    when: 'BXGY',
    notes: '',
  },
  {
    step: 2,
    key: 'offer_bxgy_getQty',
    label: 'Customer gets free',
    path: 'offer.bxgy.getQty',
    type: 'number',
    required: 'conditional',
    default: '1',
    when: 'BXGY',
    notes: '',
  },
  {
    step: 2,
    key: 'offer_bxgy_productId',
    label: 'Applies to item',
    path: 'offer.bxgy.productId',
    type: 'itemselect',
    required: 'conditional',
    default: '""',
    when: 'BXGY',
    notes: 'Menu product ID. The free item is the same or a cheaper one',
  },
  {
    step: 2,
    key: 'offer_freeItem_productId',
    label: 'Free item',
    path: 'offer.freeItem.productId',
    type: 'itemselect',
    required: 'conditional',
    default: '""',
    when: 'FREE_ITEM',
    notes: 'Menu product ID from the brand menu',
  },
  {
    step: 2,
    key: 'offer_freeItem_quantity',
    label: 'Quantity',
    path: 'offer.freeItem.quantity',
    type: 'number',
    required: 'no',
    default: '1',
    when: 'FREE_ITEM',
    notes: '',
  },
  {
    step: 2,
    key: 'offer_bundle_productIds',
    label: 'Items in the bundle',
    path: 'offer.bundle.productIds[]',
    type: 'itempicker',
    required: 'conditional',
    default: '[]',
    when: 'BUNDLE',
    notes: 'At least 2 menu items',
  },
  {
    step: 2,
    key: 'offer_bundle_priceSar',
    label: 'Bundle price',
    path: 'offer.bundle.priceSar',
    type: 'number',
    required: 'conditional',
    default: '32',
    when: 'BUNDLE',
    notes: 'Below the items’ normal total',
  },
  {
    step: 2,
    key: 'offer_deliveryFeeCoveredSar',
    label: 'Delivery fee covered',
    path: 'offer.deliveryFeeCoveredSar',
    type: 'select',
    required: 'no',
    default: '"FULL"',
    when: 'FREE_DELIVERY',
    notes: '',
  },
  {
    step: 2,
    key: 'rules_minOrderSar',
    label: 'Minimum order',
    path: 'rules.minOrderSar',
    type: 'number',
    required: 'yes',
    default: '50',
    notes: 'Was “Order Minimum”',
  },
  {
    step: 2,
    key: 'offer_cashback_creditValidityDays',
    label: 'Credit can be used for',
    path: 'offer.cashback.creditValidityDays',
    type: 'number',
    required: 'no',
    default: '14',
    when: 'CASHBACK',
    notes: '',
  },
  {
    step: 2,
    key: 'offer_posDiscountCode',
    label: 'POS discount code',
    path: 'offer.posDiscountCode',
    type: 'text',
    required: 'no',
    default: '""',
    notes: 'Kept from the current screen (posDiscountCode)',
  },
  {
    step: 2,
    key: 'offer_onRefund',
    label: 'If the order is refunded',
    path: 'offer.onRefund',
    type: 'select',
    required: 'no',
    default: '"RETURN_IF_VALID"',
    notes: '',
  },
  {
    step: 2,
    key: 'offer_onCancelBeforeCompletion',
    label: 'If the order is cancelled before delivery',
    path: 'offer.onCancelBeforeCompletion',
    type: 'select',
    required: 'no',
    default: '"REISSUE_IF_VALID"',
    notes: '',
  },
  {
    step: 2,
    key: 'experiment_enabled',
    label: 'Test two discount values against each other',
    path: 'experiment.enabled',
    type: 'bool',
    required: 'no',
    default: 'false',
    when: 'PERCENT | FIXED | CASHBACK',
    notes: 'Only for percentage, fixed amount and cashback',
  },
  {
    step: 2,
    key: 'experiment_variantB_value',
    label: 'Version B amount',
    path: 'experiment.variantB.value',
    type: 'number',
    required: 'conditional',
    default: '10',
    when: 'experiment',
    notes: 'Version A is the main discount value',
  },
  {
    step: 2,
    key: 'experiment_splitPctA',
    label: 'Share who get version A',
    path: 'experiment.splitPctA',
    type: 'range',
    required: 'no',
    default: '50',
    when: 'experiment',
    notes: '10–90%; the rest get version B',
  },
  {
    step: 2,
    key: 'experiment_winnerMetric',
    label: 'Pick the winner by',
    path: 'experiment.winnerMetric',
    type: 'select',
    required: 'no',
    default: '"PROFIT"',
    when: 'experiment',
    notes: '',
  },
  {
    step: 2,
    key: 'experiment_autoWinnerAfterDays',
    label: 'Send everyone the winner after',
    path: 'experiment.autoWinnerAfterDays',
    type: 'number',
    required: 'no',
    default: '7',
    when: 'experiment',
    notes: '',
  },
  {
    step: 2,
    key: 'trigger_birthday_occasion',
    label: 'Celebrate',
    path: 'trigger.birthday.occasion',
    type: 'radio',
    required: 'no',
    default: '"BIRTHDAY"',
    when: 'OCCASION',
    notes: '',
  },
  {
    step: 2,
    key: 'trigger_birthday_issueDaysBefore',
    label: 'Send the gift',
    path: 'trigger.birthday.issueDaysBefore',
    type: 'number',
    required: 'no',
    default: '3',
    when: 'OCCASION',
    notes: 'One gift per occasion per year',
  },
  {
    step: 2,
    key: 'trigger_birthday_missingDateOfBirth',
    label: 'Customers without a date of birth',
    path: 'trigger.birthday.missingDateOfBirth',
    type: 'select',
    required: 'no',
    default: '"ASK"',
    when: 'OCCASION',
    notes: 'Date of birth can be edited only once, to stop repeated gifts',
  },
  {
    step: 2,
    key: 'trigger_birthday_tierBoost_enabled',
    label: 'Give Gold and VIP members a bigger gift',
    path: 'trigger.birthday.tierBoost.enabled',
    type: 'bool',
    required: 'no',
    default: 'true',
    when: 'OCCASION',
    notes: '',
  },
  {
    step: 2,
    key: 'trigger_birthday_tierBoost_extraSar',
    label: 'Extra value for Gold and VIP',
    path: 'trigger.birthday.tierBoost.extraSar',
    type: 'number',
    required: 'conditional',
    default: '10',
    when: 'OCCASION',
    notes: '',
  },
  {
    step: 2,
    key: 'loyalty_type',
    label: 'How customers earn the reward',
    path: 'loyalty.type',
    type: 'cards',
    required: 'conditional',
    default: '"STAMP"',
    when: 'FREQUENT_ORDER',
    notes: 'STAMP, CHALLENGE or MILESTONE',
  },
  {
    step: 2,
    key: 'loyalty_ordersRequired',
    label: 'Orders per stamp card',
    path: 'loyalty.ordersRequired',
    type: 'number',
    required: 'conditional',
    default: '5',
    when: 'STAMP | CHALLENGE',
    notes: '',
  },
  {
    step: 2,
    key: 'loyalty_windowDays',
    label: 'Within',
    path: 'loyalty.windowDays',
    type: 'number',
    required: 'conditional',
    default: '30',
    when: 'CHALLENGE',
    notes: '',
  },
  {
    step: 2,
    key: 'loyalty_stampExpiryDays',
    label: 'Stamps expire after',
    path: 'loyalty.stampExpiryDays',
    type: 'number',
    required: 'no',
    default: '60',
    when: 'FREQUENT_ORDER',
    notes: '',
  },
  {
    step: 2,
    key: 'loyalty_milestones',
    label: 'Reward on lifetime order number',
    path: 'loyalty.milestones[]',
    type: 'multi',
    required: 'conditional',
    default: '["5","10","25"]',
    when: 'MILESTONE',
    notes: '',
  },
  {
    step: 2,
    key: 'loyalty_minOrderToCountSar',
    label: 'An order counts if it is at least',
    path: 'loyalty.minOrderToCountSar',
    type: 'number',
    required: 'no',
    default: '30',
    when: 'FREQUENT_ORDER',
    notes: '',
  },
  {
    step: 2,
    key: 'loyalty_countOrdersFrom',
    label: 'Which orders count',
    path: 'loyalty.countOrdersFrom',
    type: 'radio',
    required: 'no',
    default: '"ANY"',
    when: 'FREQUENT_ORDER',
    notes: '',
  },
  {
    step: 2,
    key: 'loyalty_repeat',
    label: 'Start a new card after each reward',
    path: 'loyalty.repeat',
    type: 'bool',
    required: 'no',
    default: 'true',
    when: 'FREQUENT_ORDER',
    notes: '',
  },
  {
    step: 2,
    key: 'loyalty_progressMessages',
    label: 'Send a progress message after each order (e.g. “2 more orders to go”)',
    path: 'loyalty.progressMessages',
    type: 'bool',
    required: 'no',
    default: 'true',
    when: 'FREQUENT_ORDER',
    notes: '',
  },
  {
    step: 3,
    key: 'audience_mode',
    label: 'How do you want to choose customers?',
    path: 'audience.mode',
    type: 'radio',
    required: 'yes',
    default: '"SEGMENT"',
    notes: '',
  },
  {
    step: 3,
    key: 'audience_conditions',
    label: 'Conditions',
    path: 'audience.conditions[]',
    type: 'rules',
    required: 'conditional',
    default: '[{"c":"ORDERED_ONCE","p":""}]',
    when: 'SEGMENT',
    notes: 'Each { condition, value }; combined by audience.match = ALL (AND) or ANY (OR)',
  },
  {
    step: 3,
    key: 'audience_phoneNumbers',
    label: 'Customer phone numbers',
    path: 'audience.phoneNumbers[]',
    type: 'textarea',
    required: 'conditional',
    default: '[]',
    when: 'PHONES',
    notes: 'Saudi mobile numbers +9665XXXXXXXX',
  },
  {
    step: 3,
    key: 'audience_visibility',
    label: 'Who can see the coupon in the app?',
    path: 'audience.visibility',
    type: 'select',
    required: 'no',
    default: '"TARGETED"',
    notes: '',
  },
  {
    step: 3,
    key: 'audience_controlGroupPct',
    label: 'Measurement group',
    path: 'audience.controlGroupPct',
    type: 'range',
    required: 'no',
    default: '10',
    notes: '0–20%',
  },
  {
    step: 3,
    key: 'audience_excludeDiscountSensitive',
    label: 'Leave out customers who almost only order with coupons',
    path: 'audience.excludeDiscountSensitive',
    type: 'bool',
    required: 'no',
    default: 'true',
    notes: '',
  },
  {
    step: 4,
    key: 'rules_maxOrderSar',
    label: 'Maximum eligible order (optional)',
    path: 'rules.maxOrderSar',
    type: 'number',
    required: 'no',
    default: '0',
    notes: 'Was “Order Maximum”',
  },
  {
    step: 4,
    key: 'rules_previousOrders',
    label: 'Number of previous orders',
    path: 'rules.previousOrders',
    type: 'select',
    required: 'no',
    default: '"ANY"',
    notes: '',
  },
  {
    step: 4,
    key: 'rules_firstOrderOnly',
    label: 'Only valid on the customer’s first order',
    path: 'rules.firstOrderOnly',
    type: 'bool',
    required: 'no',
    default: 'false',
    notes: '',
  },
  {
    step: 4,
    key: 'rules_paymentMethods',
    label: 'Payment methods',
    path: 'rules.paymentMethods[]',
    type: 'multi',
    required: 'yes',
    default: '["MADA","CARD","APPLE_PAY","CASH","WALLET"]',
    notes: '',
  },
  {
    step: 4,
    key: 'scope_allBrands',
    label: 'All brands and branches, including future ones',
    path: 'scope.allBrands',
    type: 'bool',
    required: 'no',
    default: 'true',
    notes: '',
  },
  {
    step: 4,
    key: 'scope_brandIds',
    label: 'Brands',
    path: 'scope.brandIds[]',
    type: 'multi',
    required: 'conditional',
    default: '[]',
    when: 'not allBrands',
    notes: 'Replaces Brand + Assignment tree',
  },
  {
    step: 4,
    key: 'scope_branchIds',
    label: 'Branches (optional)',
    path: 'scope.branchIds[]',
    type: 'multi',
    required: 'no',
    default: '[]',
    notes: 'Replaces “Restaurant”',
  },
  {
    step: 4,
    key: 'scope_categoryIds',
    label: 'Menu categories (optional)',
    path: 'scope.categoryIds[]',
    type: 'multi',
    required: 'no',
    default: '[]',
    notes: 'Value = BRAND|Category from the menu',
  },
  {
    step: 4,
    key: 'scope_productIds',
    label: 'Only these items (optional)',
    path: 'scope.productIds[]',
    type: 'itempicker',
    required: 'no',
    default: '[]',
    notes: 'Was “Related Items”',
  },
  {
    step: 4,
    key: 'scope_excludedProductIds',
    label: 'Excluded items (optional)',
    path: 'scope.excludedProductIds[]',
    type: 'itempicker',
    required: 'no',
    default: '[]',
    notes: '',
  },
  {
    step: 4,
    key: 'scope_orderTypes',
    label: 'Order types',
    path: 'scope.orderTypes[]',
    type: 'multi',
    required: 'yes',
    default: '["DELIVERY","PICKUP","CARHOP"]',
    notes: 'Replaces “Delivery Types”',
  },
  {
    step: 4,
    key: 'limits_perCustomerMode',
    label: 'Redemptions per customer',
    path: 'limits.perCustomerMode',
    type: 'radio',
    required: 'no',
    default: '"ONE"',
    notes: '',
  },
  {
    step: 4,
    key: 'limits_perCustomerMax',
    label: 'Maximum per customer',
    path: 'limits.perCustomerMax',
    type: 'number',
    required: 'conditional',
    default: '3',
    when: 'MONTHLY',
    notes: 'Was “Monthly coupon use”',
  },
  {
    step: 4,
    key: 'limits_totalRedemptions',
    label: 'Total redemption limit',
    path: 'limits.totalRedemptions',
    type: 'number',
    required: 'yes',
    default: '3000',
    notes: '',
  },
  {
    step: 4,
    key: 'limits_dailyRedemptions',
    label: 'Daily redemption limit (optional)',
    path: 'limits.dailyRedemptions',
    type: 'number',
    required: 'no',
    default: '0',
    notes: '',
  },
  {
    step: 4,
    key: 'limits_budgetSar',
    label: 'Discount budget',
    path: 'limits.budgetSar',
    type: 'number',
    required: 'yes',
    default: '20000',
    notes: 'Was “Total given discount limit”',
  },
  {
    step: 4,
    key: 'distribution_codeType',
    label: 'Coupon code',
    path: 'distribution.codeType',
    type: 'radio',
    required: 'no',
    default: '"NONE"',
    notes: '',
  },
  {
    step: 4,
    key: 'distribution_code',
    label: 'Shared code',
    path: 'distribution.code',
    type: 'text',
    required: 'conditional',
    default: '""',
    when: 'SHARED',
    notes: 'Unique across live campaigns. Was “code”.',
  },
  {
    step: 4,
    key: 'distribution_uniqueCodeCount',
    label: 'Number of unique codes',
    path: 'distribution.uniqueCodeCount',
    type: 'number',
    required: 'conditional',
    default: '5000',
    when: 'UNIQUE',
    notes: '',
  },
  {
    step: 4,
    key: 'stacking_combineWithOtherOffers',
    label: 'Can this coupon be used with other offers?',
    path: 'stacking.combineWithOtherOffers',
    type: 'yesno',
    required: 'no',
    default: 'false',
    notes:
      'Checked by the checkout service. Replaces “Don’t apply Offer / loyalty with this coupon”',
  },
  {
    step: 4,
    key: 'stacking_combineWithLoyalty',
    label: 'Can this coupon be combined with loyalty benefits?',
    path: 'stacking.combineWithLoyalty',
    type: 'yesno',
    required: 'no',
    default: 'true',
    notes:
      'Loyalty benefits: cashback redemption, points redemption, VIP benefits, loyalty discounts and promotions',
  },
  {
    step: 4,
    key: 'stacking_combineWithOtherCoupons',
    label: 'Can this coupon be combined with other discounts?',
    path: 'stacking.combineWithOtherCoupons',
    type: 'yesno',
    required: 'no',
    default: 'false',
    notes: 'Other coupon discounts and promo codes',
  },
  {
    step: 4,
    key: 'offer_partialRedemption_enabled',
    label: 'Allow partial redemption?',
    path: 'offer.partialRedemption.enabled',
    type: 'yesno',
    required: 'no',
    default: 'false',
    when: 'FIXED',
    notes: 'Fixed-amount coupons only. A ledger keeps the remaining balance per customer.',
  },
  {
    step: 4,
    key: 'offer_partialRedemption_maxPerOrderSar',
    label: 'Maximum per order (optional)',
    path: 'offer.partialRedemption.maxPerOrderSar',
    type: 'number',
    required: 'no',
    default: '""',
    when: 'partial',
    notes: 'Optional',
  },
  {
    step: 4,
    key: 'offer_partialRedemption_balanceExpiry',
    label: 'Remaining balance expiry',
    path: 'offer.partialRedemption.balanceExpiry',
    type: 'select',
    required: 'no',
    default: '"SAME"',
    when: 'partial',
    notes: '',
  },
  {
    step: 4,
    key: 'offer_partialRedemption_onOrderCancel',
    label: 'If an order is cancelled or refunded',
    path: 'offer.partialRedemption.onOrderCancel',
    type: 'select',
    required: 'no',
    default: '"RESTORE"',
    when: 'partial',
    notes: 'Each redemption can be restored once; a second cancellation gives no credit',
  },
  {
    step: 4,
    key: 'rules_binRanges',
    label: 'Bank card ranges (partner offers, optional)',
    path: 'rules.binRanges[]',
    type: 'text',
    required: 'no',
    default: '[]',
    notes: 'Restored from the earlier version',
  },
  {
    step: 4,
    key: 'fraud_onePerPhoneAndDevice',
    label: 'One use per phone number and device, even across accounts',
    path: 'fraud.onePerPhoneAndDevice',
    type: 'bool',
    required: 'no',
    default: 'false',
    notes: 'Mandatory for first-order and new-customer coupons',
  },
  {
    step: 4,
    key: 'fraud_excludeStaffAndTestAccounts',
    label: 'Exclude staff and test accounts',
    path: 'fraud.excludeStaffAndTestAccounts',
    type: 'bool',
    required: 'no',
    default: 'false',
    notes: '',
  },
  {
    step: 4,
    key: 'fraud_blockFlaggedCustomers',
    label: 'Block customers flagged for coupon abuse',
    path: 'fraud.blockFlaggedCustomers',
    type: 'bool',
    required: 'no',
    default: 'false',
    notes: '',
  },
  {
    step: 5,
    key: 'schedule_startDate',
    label: 'Campaign start date',
    path: 'schedule.startDate',
    type: 'date',
    required: 'yes',
    default: 'today',
    notes: 'Was “Enter a date range”',
  },
  {
    step: 5,
    key: 'schedule_endDate',
    label: 'Campaign end date',
    path: 'schedule.endDate',
    type: 'date',
    required: 'yes',
    default: 'today + validityDays',
    notes: '',
  },
  {
    step: 5,
    key: 'schedule_allDay',
    label: 'Valid all day',
    path: 'schedule.allDay',
    type: 'bool',
    required: 'no',
    default: 'true',
    notes: '',
  },
  {
    step: 5,
    key: 'schedule_timeWindow_from',
    label: 'Start time',
    path: 'schedule.timeWindow.from',
    type: 'time',
    required: 'no',
    default: '""',
    when: 'not allDay',
    notes: 'Was “From Time”',
  },
  {
    step: 5,
    key: 'schedule_timeWindow_to',
    label: 'End time',
    path: 'schedule.timeWindow.to',
    type: 'time',
    required: 'no',
    default: '""',
    when: 'not allDay',
    notes: 'Was “To Time”',
  },
  {
    step: 5,
    key: 'schedule_onlyDuringBranchHours',
    label: 'Only during each branch’s opening hours',
    path: 'schedule.onlyDuringBranchHours',
    type: 'bool',
    required: 'no',
    default: 'false',
    notes: '',
  },
  {
    step: 5,
    key: 'schedule_daysOfWeek',
    label: 'Days of the week',
    path: 'schedule.daysOfWeek[]',
    type: 'multi',
    required: 'yes',
    default: '[0..6]',
    notes: 'Replaces the 7 day checkboxes',
  },
  {
    step: 5,
    key: 'schedule_expiresAfterIssueDays',
    label: 'Coupon expires after it is issued',
    path: 'schedule.expiresAfterIssueDays',
    type: 'number',
    required: 'yes',
    default: 'validityDays',
    notes: '',
  },
  {
    step: 5,
    key: 'schedule_limitedTime_enabled',
    label: 'Limited-time redemption (flash offer)',
    path: 'schedule.limitedTime.enabled',
    type: 'bool',
    required: 'no',
    default: 'false',
    notes: '',
  },
  {
    step: 5,
    key: 'schedule_limitedTime_hours',
    label: 'Must be used within',
    path: 'schedule.limitedTime.hours',
    type: 'number',
    required: 'conditional',
    default: '24',
    when: 'limitedTime',
    notes: '',
  },
  {
    step: 6,
    key: 'distribution_channels',
    label: 'Channels',
    path: 'distribution.channels[]',
    type: 'multicards',
    required: 'yes',
    default: '["APP_WALLET","PUSH"]',
    notes: 'At least 1',
  },
  {
    step: 6,
    key: 'distribution_addMode',
    label: 'How is the coupon added to the customer?',
    path: 'distribution.addMode',
    type: 'cards',
    required: 'no',
    default: '"AUTO_WALLET"',
    notes: '',
  },
  {
    step: 6,
    key: 'distribution_issueMode',
    label: 'How is the coupon issued?',
    path: 'distribution.issueMode',
    type: 'radio',
    required: 'no',
    default: '"ALL_AT_ONCE"',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_push_title_en',
    label: 'Notification title (English)',
    path: 'communication.push.title.en',
    type: 'text',
    required: 'conditional',
    default: '""',
    when: 'PUSH',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_push_title_ar',
    label: 'Notification title (Arabic)',
    path: 'communication.push.title.ar',
    type: 'text',
    required: 'conditional',
    default: '""',
    when: 'PUSH',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_sendTime',
    label: 'Send',
    path: 'communication.sendTime',
    type: 'select',
    required: 'no',
    default: '"ON_ISSUE"',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_push_body_en',
    label: 'Message (English)',
    path: 'communication.push.body.en',
    type: 'textarea',
    required: 'conditional',
    default: '""',
    when: 'PUSH',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_push_body_ar',
    label: 'Message (Arabic)',
    path: 'communication.push.body.ar',
    type: 'textarea',
    required: 'conditional',
    default: '""',
    when: 'PUSH',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_banner_text_en',
    label: 'Banner headline (English)',
    path: 'communication.banner.text.en',
    type: 'text',
    required: 'conditional',
    default: '""',
    when: 'IN_APP_BANNER',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_banner_text_ar',
    label: 'Banner headline (Arabic)',
    path: 'communication.banner.text.ar',
    type: 'text',
    required: 'conditional',
    default: '""',
    when: 'IN_APP_BANNER',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_sms_text_en',
    label: 'SMS text (English)',
    path: 'communication.sms.text.en',
    type: 'textarea',
    required: 'conditional',
    default: '""',
    when: 'SMS',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_sms_text_ar',
    label: 'SMS text (Arabic)',
    path: 'communication.sms.text.ar',
    type: 'textarea',
    required: 'conditional',
    default: '""',
    when: 'SMS',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_frequencyCap',
    label: 'Maximum promotional messages per customer',
    path: 'communication.frequencyCap',
    type: 'select',
    required: 'no',
    default: '"THREE_PER_WEEK"',
    notes: 'Shared limit across campaigns; enforced by the notification service',
  },
  {
    step: 6,
    key: 'communication_quietHours',
    label: 'No messages between 23:00 and 09:00',
    path: 'communication.quietHours',
    type: 'bool',
    required: 'no',
    default: 'true',
    notes: '',
  },
  {
    step: 6,
    key: 'communication_respectConsent',
    label: 'Only message customers who agreed to marketing messages',
    path: 'communication.respectConsent',
    type: 'bool',
    required: 'no',
    default: 'true',
    notes: 'Must stay on for SMS and email (PDPL); customers can opt out at any time',
  },
  {
    step: 7,
    key: 'forecast_baselineOrderRatePct',
    label: 'Customers who would order anyway',
    path: 'forecast.baselineOrderRatePct',
    type: 'number',
    required: 'no',
    default: '""',
    notes: 'Planning input; empty = estimated from the audience',
  },
  {
    step: 7,
    key: 'forecast_expectedUpliftPts',
    label: 'Extra customers the coupon brings',
    path: 'forecast.expectedUpliftPts',
    type: 'number',
    required: 'no',
    default: '""',
    notes: 'Planning input; empty = estimated from the objective',
  },
];

/**
 * Code-only fields kept beside the design's 107 (field-parity.md lists why):
 * something in the engine depends on each of them.
 */
export const CAMPAIGN_CODE_ONLY_FIELDS: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: 'audience.match',
    why: "The design's conditions row combines them by audience.match = ALL (AND) or ANY (OR).",
  },
  {
    path: 'audience.listId',
    why: "audience.mode LIST (the compensation goal's recommended audience) needs the list it sends to.",
  },
  {
    path: 'studyId',
    why: 'Links a campaign to the pre-study it came from; set by the Studies pages, not typed in the form.',
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
      return offer.deliveryFeeCoveredSar === 'FULL' || offer.deliveryFeeCoveredSar === undefined
        ? 'Free delivery'
        : `SAR ${offer.deliveryFeeCoveredSar} off delivery`;
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

/** One dotted path out of a campaign or draft (`schedule.startDate`). */
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
