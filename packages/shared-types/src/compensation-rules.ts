import {
  couponTermsProblems,
  defaultCouponDates,
  findIssuingSide,
  isPercentageCategory,
  parseDeliveryTypes,
  type CouponRequestDraft,
} from './coupon-request.js';

/**
 * THE COMPENSATION RULES ENGINE (owner, 2026-10-27).
 *
 * Operations' compensation policy as DATA (`compensation_rules`, edited on the
 * admin portal's "Compensation rules" page): "for THIS kind of complaint, offer
 * THIS coupon". A rule only ever SUGGESTS - every coupon it produces is still a
 * `pending` request a WeCare supervisor approves, exactly like an agent's.
 *
 * One pure matcher, read by both sides so they cannot disagree:
 *  - the agent portal, to PRE-FILL the coupon section of a new ticket;
 *  - the socket gateway, to raise the coupon request for a ticket Yiji sends
 *    without one.
 *
 * Nothing here calls Yiji, and nothing here reads per row: the caller loads the
 * (small) rule list once and asks this module about one ticket.
 */

/** One row of `compensation_rules`, as both readers load it. */
export interface CompensationRule {
  id: string;
  name: string;
  active: boolean;
  /** Higher wins between two equally specific rules. */
  priority: number;
  /* ── conditions ──────────────────────────────────────────────────────── */
  /** Required. Compared case-insensitively. */
  complaint_type: string;
  /** Null = any service type. */
  service_type?: string | null;
  /** Null = any delay. Set = the ticket's delay must be KNOWN and at least this. */
  min_delay_minutes?: number | null;
  /** Null = no floor. Set = the order value must be KNOWN and at least this (SAR). */
  min_order_value?: number | null;
  /** Null = no ceiling. Set = the order value must be KNOWN and at most this (SAR). */
  max_order_value?: number | null;
  /* ── outcome: the coupon it suggests ─────────────────────────────────── */
  /** `Amount` or `Percentage` (the option-list words). */
  discount_category: string;
  /** SAR off, for an Amount rule. */
  coupon_value?: number | null;
  /** Percent off, for a Percentage rule. */
  coupon_percent?: number | null;
  /** Ceiling in SAR. Required for a Percentage rule; an Amount's cap is its value. */
  max_discount?: number | null;
  /** Whole days, inclusive. Null = the standard one month (`defaultCouponDates`). */
  validity_days?: number | null;
  usage_limit?: number | null;
  /** Comma-joined, like `coupon_approvals.delivery_type`. Null = "All". */
  delivery_type?: string | null;
  /** Null = "Private" (the default for a compensation coupon). */
  coupon_type?: string | null;
  /** Null = "Customer Care". */
  issuing_side?: string | null;
  no_other_discounts?: boolean | null;
  note?: string | null;
  date_created?: string | null;
}

/** What is known about the ticket a rule is asked about. */
export interface CompensationRuleInputs {
  complaintType: string | null | undefined;
  serviceType?: string | null;
  /** How late the order was, in minutes. Null/absent = unknown. */
  delayMinutes?: number | null;
  /** The order's value in SAR. Null/absent = unknown. */
  orderValue?: number | null;
}

const key = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const set = (v: unknown): boolean => v !== null && v !== undefined && v !== '';

/** Does this rule's every condition hold for the ticket? (Ignores `active`.) */
export function ruleMatches(rule: CompensationRule, input: CompensationRuleInputs): boolean {
  if (!key(rule.complaint_type) || key(rule.complaint_type) !== key(input.complaintType)) {
    return false;
  }
  if (set(rule.service_type) && key(rule.service_type) !== key(input.serviceType)) return false;
  if (isNum(rule.min_delay_minutes)) {
    if (!isNum(input.delayMinutes) || input.delayMinutes < rule.min_delay_minutes) return false;
  }
  if (isNum(rule.min_order_value)) {
    if (!isNum(input.orderValue) || input.orderValue < rule.min_order_value) return false;
  }
  if (isNum(rule.max_order_value)) {
    if (!isNum(input.orderValue) || input.orderValue > rule.max_order_value) return false;
  }
  return true;
}

/** How many optional conditions a rule names - the more, the more specific. */
export function ruleSpecificity(rule: CompensationRule): number {
  return [
    set(rule.service_type),
    isNum(rule.min_delay_minutes),
    isNum(rule.min_order_value),
    isNum(rule.max_order_value),
  ].filter(Boolean).length;
}

/**
 * THE rule for a ticket, or null when none applies.
 *
 * Only ACTIVE rules. When several match, the MOST SPECIFIC wins (a "Late order,
 * Delivery, 60+ minutes" rule beats a plain "Late order" one); between equally
 * specific rules the higher `priority` wins; a remaining tie goes to the older
 * rule, then the id - so the answer never depends on the order rows arrived in.
 */
export function pickCompensationRule(
  rules: readonly CompensationRule[],
  input: CompensationRuleInputs,
): CompensationRule | null {
  const matching = rules.filter((r) => r.active !== false && ruleMatches(r, input));
  if (matching.length === 0) return null;
  return [...matching].sort((a, b) => {
    const s = ruleSpecificity(b) - ruleSpecificity(a);
    if (s !== 0) return s;
    const p = (b.priority ?? 0) - (a.priority ?? 0);
    if (p !== 0) return p;
    const d = (a.date_created ?? '').localeCompare(b.date_created ?? '');
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  })[0]!;
}

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The coupon terms a rule decides - everything except who and which order. */
export interface RuleCouponTerms {
  discount_category: string;
  coupon_value: number | null;
  coupon_percent: number | null;
  max_discount: number;
  valid_from: string;
  valid_to: string;
  usage_limit: number;
  delivery_type: string;
  coupon_type: string;
  issuing_side: string;
  no_other_discounts: boolean;
}

/**
 * The coupon a rule suggests, starting `today`.
 *
 * The money follows the agent form's own rule: for an AMOUNT the ceiling IS the
 * amount; a PERCENTAGE carries the rule's cap.
 */
export function ruleCouponTerms(rule: CompensationRule, today: Date): RuleCouponTerms {
  const pct = isPercentageCategory(rule.discount_category);
  const value = pct ? null : isNum(rule.coupon_value) ? rule.coupon_value : null;
  const percent = pct ? (isNum(rule.coupon_percent) ? rule.coupon_percent : null) : null;
  const days =
    isNum(rule.validity_days) && rule.validity_days >= 1 ? Math.floor(rule.validity_days) : null;
  const std = defaultCouponDates(today);
  const from = iso(today);
  const to = days
    ? iso(new Date(Date.parse(`${from}T00:00:00Z`) + (days - 1) * DAY_MS))
    : std.valid_to;
  return {
    discount_category: pct ? 'Percentage' : 'Amount',
    coupon_value: value,
    coupon_percent: percent,
    max_discount: pct ? (isNum(rule.max_discount) ? rule.max_discount : 0) : (value ?? 0),
    valid_from: from,
    valid_to: to,
    usage_limit:
      isNum(rule.usage_limit) && rule.usage_limit >= 1 ? Math.floor(rule.usage_limit) : 1,
    delivery_type: rule.delivery_type?.trim() || 'All',
    coupon_type: rule.coupon_type?.trim() || 'Private',
    issuing_side:
      findIssuingSide(rule.issuing_side)?.value ?? (rule.issuing_side?.trim() || 'Customer Care'),
    no_other_discounts: rule.no_other_discounts === true,
  };
}

/** A whole coupon draft from a rule, for a form that needs every field. */
export function ruleCouponDraft(
  rule: CompensationRule,
  ctx: {
    today: Date;
    title: string;
    code: string;
    reason?: string | null;
    brandId?: string | null;
    restaurantId?: string | null;
  },
): CouponRequestDraft {
  return {
    ...ruleCouponTerms(rule, ctx.today),
    title: ctx.title,
    code: ctx.code,
    compensation_reason: (ctx.reason ?? '').slice(0, 2000),
    brand_id: ctx.brandId ?? null,
    restaurant_id: ctx.restaurantId ?? null,
    item_name: null,
    item_sku: null,
    delivery_excluded: false,
    delivery_excluded_reason: null,
  };
}

/** Inclusive length of a validity window in days, or null when unreadable. */
function windowDays(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = Date.parse(`${from ?? ''}T00:00:00Z`);
  const b = Date.parse(`${to ?? ''}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS) + 1;
}

const sameNum = (a: number | null | undefined, b: number | null | undefined) =>
  (isNum(a) ? a : null) === (isNum(b) ? b : null);

/** The policy-relevant fields of a coupon (a draft or a stored request). */
export type PolicyComparable = Pick<
  CouponRequestDraft,
  | 'discount_category'
  | 'coupon_value'
  | 'coupon_percent'
  | 'max_discount'
  | 'valid_from'
  | 'valid_to'
  | 'usage_limit'
  | 'delivery_type'
  | 'coupon_type'
  | 'issuing_side'
  | 'no_other_discounts'
>;

export type PolicyField =
  | 'discount_category'
  | 'coupon_value'
  | 'coupon_percent'
  | 'max_discount'
  | 'validity'
  | 'usage_limit'
  | 'delivery_type'
  | 'coupon_type'
  | 'issuing_side'
  | 'no_other_discounts';

/**
 * Where a coupon departs from what its rule suggested.
 *
 * The TERMS only: the title, the code, the reason, the item, the branch and
 * whether it is withheld from the app are the agent's to set and never a
 * departure from policy. Validity is compared by LENGTH, not by date, so a
 * suggestion accepted the next morning does not read as an adjustment.
 */
export function policyDifferences(
  policy: PolicyComparable,
  actual: PolicyComparable,
): PolicyField[] {
  const out: PolicyField[] = [];
  const pct = isPercentageCategory(actual.discount_category);
  if (isPercentageCategory(policy.discount_category) !== pct) out.push('discount_category');
  if (!pct && !sameNum(policy.coupon_value, actual.coupon_value)) out.push('coupon_value');
  if (pct && !sameNum(policy.coupon_percent, actual.coupon_percent)) out.push('coupon_percent');
  if (!sameNum(policy.max_discount, actual.max_discount)) out.push('max_discount');
  if (
    windowDays(policy.valid_from, policy.valid_to) !==
    windowDays(actual.valid_from, actual.valid_to)
  ) {
    out.push('validity');
  }
  if (!sameNum(policy.usage_limit, actual.usage_limit)) out.push('usage_limit');
  const types = (s: string | null | undefined) =>
    parseDeliveryTypes(s)
      .map((t) => t.toLowerCase())
      .sort()
      .join('|');
  if (types(policy.delivery_type) !== types(actual.delivery_type)) out.push('delivery_type');
  if (key(policy.coupon_type) !== key(actual.coupon_type)) out.push('coupon_type');
  const side = (s: string | null | undefined) => findIssuingSide(s)?.value ?? key(s);
  if (side(policy.issuing_side) !== side(actual.issuing_side)) out.push('issuing_side');
  if ((policy.no_other_discounts === true) !== (actual.no_other_discounts === true)) {
    out.push('no_other_discounts');
  }
  return out;
}

/** True when a coupon's terms are not what its rule suggested. */
export function differsFromPolicy(policy: PolicyComparable, actual: PolicyComparable): boolean {
  return policyDifferences(policy, actual).length > 0;
}

/** What the rule editor refuses, keyed by column. Empty = a valid rule. */
export function compensationRuleProblems(rule: Partial<CompensationRule>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rule.name?.trim()) out.name = 'Give the rule a name.';
  if (!rule.complaint_type?.trim()) out.complaint_type = 'Choose the complaint type.';
  const cat = rule.discount_category?.trim() ?? '';
  if (!/^(amount|percent)/i.test(cat)) out.discount_category = 'Choose Amount or Percentage.';
  for (const p of couponTermsProblems({
    discount_category: cat,
    coupon_value: rule.coupon_value ?? null,
    coupon_percent: rule.coupon_percent ?? null,
    // An Amount's ceiling is its value; only a Percentage carries its own.
    max_discount: isPercentageCategory(cat) ? (rule.max_discount ?? null) : null,
  })) {
    out[p.field] ??= p.message;
  }
  if (isNum(rule.coupon_percent) && rule.coupon_percent > 100) {
    out.coupon_percent = 'A percentage cannot be over 100.';
  }
  const nonNeg = (k: 'min_delay_minutes' | 'min_order_value' | 'max_order_value') => {
    const v = rule[k];
    if (set(v) && (!isNum(v) || v < 0)) out[k] = 'Cannot be negative.';
  };
  nonNeg('min_delay_minutes');
  nonNeg('min_order_value');
  nonNeg('max_order_value');
  if (
    isNum(rule.min_order_value) &&
    isNum(rule.max_order_value) &&
    rule.max_order_value < rule.min_order_value
  ) {
    out.max_order_value = 'The maximum order value is below the minimum.';
  }
  if (set(rule.validity_days) && (!isNum(rule.validity_days) || rule.validity_days < 1)) {
    out.validity_days = 'At least one day.';
  }
  if (set(rule.usage_limit) && (!isNum(rule.usage_limit) || rule.usage_limit < 1)) {
    out.usage_limit = 'It has to be usable at least once.';
  }
  return out;
}

/* ── The optional per-customer limit (default OFF) ──────────────────────── */

/**
 * "At most N rule coupons per customer per X days" - one `app_settings` row,
 * edited on the rules page. Absent, unreadable or disabled = no limit.
 */
export const RULE_COUPON_LIMIT_SETTING_KEY = 'compensation_rules_customer_limit';

export interface RuleCouponLimit {
  maxPerCustomer: number;
  windowDays: number;
}

/** The stored setting (JSON text or object), or null when the limit is off. */
export function parseRuleCouponLimit(raw: unknown): RuleCouponLimit | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as { enabled?: unknown; maxPerCustomer?: unknown; windowDays?: unknown };
  if (o.enabled === false) return null;
  const max = Number(o.maxPerCustomer);
  const days = Number(o.windowDays);
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(days) || days < 1) return null;
  return { maxPerCustomer: max, windowDays: days };
}

/** The start of the counting window, as an ISO instant. */
export function ruleLimitSince(limit: RuleCouponLimit, now: Date): string {
  return new Date(now.getTime() - limit.windowDays * DAY_MS).toISOString();
}

/** Has the customer already had their share? `count` = rule coupons in the window. */
export function ruleLimitReached(count: number, limit: RuleCouponLimit | null): boolean {
  return !!limit && count >= limit.maxPerCustomer;
}

/**
 * The Directus filter for "rule coupons this customer got in the window" -
 * rejected ones do not count (nothing was given). Shared so the portal and the
 * gateway count the same rows. Read with `limit: maxPerCustomer`: only whether
 * the cap is reached matters, never the full list.
 */
export function ruleCouponCountFilter(
  contactId: string,
  sinceIso: string,
): Record<string, unknown> {
  return {
    _and: [
      { contact: { _eq: contactId } },
      { policy_rule: { _nnull: true } },
      { date_created: { _gte: sinceIso } },
      { status: { _neq: 'rejected' } },
    ],
  };
}
