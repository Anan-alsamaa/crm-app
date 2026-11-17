import {
  MARKETING_BRANDS,
  PAYMENT_METHODS,
  marketingCouponProblems,
  newMarketingCouponCode,
  type Campaign,
  type MarketingCouponDraft,
  type OrderType,
} from '@yiji/shared-types';

/**
 * A CAMPAIGN AS A MARKETING COUPON (owner, 2026-11-16).
 *
 * The CRM issues a campaign's coupons through the pipeline it already has: a
 * `marketing_coupons` list coupon with its `marketing_coupon_recipients`,
 * created on Yiji and handed to each customer by the workers' marketing
 * sender (behind MARKETING_COUPON_SEND). That sender talks to Yiji; nothing
 * here does.
 *
 * NEVER WIDER THAN APPROVED. A Yiji v1 coupon carries an amount or a capped
 * percentage, a minimum order, a window of days, one brand or all, the order
 * channels and uses per customer. A campaign rule it cannot carry would be
 * silently dropped - the customer would get a coupon more generous than the
 * one a manager approved - so such a campaign is refused at issuance with the
 * fields named, and stays issuable by the engine that can (v2) later.
 */

/** Order types -> the delivery-type words the coupon pipeline stores. */
const DELIVERY_WORD: Record<OrderType, string> = {
  DELIVERY: 'Delivery',
  PICKUP: 'Pickup',
  CARHOP: 'Carhop',
  DINE_IN: 'Dine-in',
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** Uses per customer, or null when the campaign has no number for it. */
export function usesPerCustomer(c: Pick<Campaign, 'limits'>): number | null {
  if (c.limits.perCustomerMode === 'ONE') return 1;
  return c.limits.perCustomerMax ?? null;
}

/** The most one customer's coupon can cost (SAR), per use. */
export function perUseCeilingSar(c: Pick<Campaign, 'offer'>): number {
  if (c.offer.type === 'FIXED') return c.offer.amountSar ?? 0;
  if (c.offer.type === 'PERCENT') return c.offer.maxDiscountSar ?? 0;
  return 0;
}

/** yyyy-mm-dd plus `n` days. */
function plusDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The last day a coupon issued on `today` can be used: the campaign's end
 * date, or sooner when the design's "expires after it is issued" says so
 * (schedule.expiresAfterIssueDays, counted from the issue day, inclusive).
 */
export function couponValidTo(c: Pick<Campaign, 'schedule'>, today: string): string {
  const n = c.schedule.expiresAfterIssueDays;
  if (!(typeof n === 'number' && n >= 1)) return c.schedule.endDate;
  const byExpiry = plusDays(today, n - 1);
  return byExpiry < c.schedule.endDate ? byExpiry : c.schedule.endDate;
}

/**
 * The spec paths whose rule the v1 coupon cannot carry. Empty = issuable.
 * `today` is a yyyy-mm-dd day.
 *
 * Every money or eligibility field of the design is either CARRIED by
 * `campaignCouponRow` (amount / percent / cap, minimum order, the window and
 * the expiry after issue, all brands or one brand, order types, uses per
 * customer, stacking) or REFUSED here with its path. Nothing is dropped.
 * docs/marketing/field-parity.md holds the full list.
 */
export function issuanceBlockers(c: Campaign, today: string): string[] {
  const out: string[] = [];
  if (c.offer.type !== 'FIXED' && c.offer.type !== 'PERCENT') out.push('offer.type');
  if (c.offer.type === 'PERCENT' && !(c.offer.maxDiscountSar && c.offer.maxDiscountSar > 0))
    out.push('offer.maxDiscountSar');
  if (c.offer.partialRedemption?.enabled) out.push('offer.partialRedemption.enabled');
  if (c.experiment?.enabled) out.push('experiment.enabled');
  if (c.trigger?.birthday?.tierBoost?.enabled) out.push('trigger.birthday.tierBoost.enabled');
  if (c.loyalty) out.push('loyalty.type');
  if (c.rules.maxOrderSar > 0) out.push('rules.maxOrderSar');
  if (c.rules.previousOrders !== 'ANY') out.push('rules.previousOrders');
  if (c.rules.firstOrderOnly) out.push('rules.firstOrderOnly');
  if (!sameSet(c.rules.paymentMethods, PAYMENT_METHODS)) out.push('rules.paymentMethods[]');
  if ((c.rules.binRanges ?? []).length) out.push('rules.binRanges[]');
  /* "All brands" off with no brand listed would issue an every-brand coupon. */
  if (c.scope.allBrands === false && c.scope.brandIds.length === 0) out.push('scope.allBrands');
  if (c.scope.brandIds.length > 1 || (c.scope.brandIds.length === 1 && !yijiBrandId(c)))
    out.push('scope.brandIds[]');
  if (c.scope.branchIds.length) out.push('scope.branchIds[]');
  if (c.scope.categoryIds.length) out.push('scope.categoryIds[]');
  if (c.scope.productIds.length) out.push('scope.productIds[]');
  if (c.scope.excludedProductIds.length) out.push('scope.excludedProductIds[]');
  if (usesPerCustomer(c) === null) out.push('limits.perCustomerMax');
  if (c.limits.dailyRedemptions > 0) out.push('limits.dailyRedemptions');
  if (c.fraud?.onePerPhoneAndDevice) out.push('fraud.onePerPhoneAndDevice');
  if (c.fraud?.excludeStaffAndTestAccounts) out.push('fraud.excludeStaffAndTestAccounts');
  if (c.fraud?.blockFlaggedCustomers) out.push('fraud.blockFlaggedCustomers');
  const s = c.schedule;
  if (s.timeWindow?.from) out.push('schedule.timeWindow.from');
  if (s.timeWindow?.to) out.push('schedule.timeWindow.to');
  if (s.onlyDuringBranchHours) out.push('schedule.onlyDuringBranchHours');
  if (!sameSet(s.daysOfWeek.map(String), ['0', '1', '2', '3', '4', '5', '6']))
    out.push('schedule.daysOfWeek[]');
  if (s.endDate < today) out.push('schedule.endDate');
  /* Issued today, it would expire before the campaign even starts. */ else if (
    couponValidTo(c, today) < s.startDate
  )
    out.push('schedule.expiresAfterIssueDays');
  if (s.limitedTime?.enabled) out.push('schedule.limitedTime.enabled');
  if (
    c.distribution.codeType === 'SHARED' &&
    !/^MKT-[A-Z0-9]{4,16}$/.test(c.distribution.code ?? '')
  )
    out.push('distribution.code');
  if (c.distribution.addMode === 'CUSTOMER_CLAIMS') out.push('distribution.addMode');
  if (c.distribution.issueMode === 'WHEN_ELIGIBLE') out.push('distribution.issueMode');
  return out;
}

/** The catalogue's brand ids are Yiji's (MARKETING_BRANDS); null = every brand, including
 *  ones opened later (scope.allBrands). */
export function yijiBrandId(c: Pick<Campaign, 'scope'>): number | null {
  const id = c.scope.brandIds[0];
  if (!id) return null;
  const hit = MARKETING_BRANDS.find((b) => String(b.yijiId) === id);
  return hit ? hit.yijiId : null;
}

/**
 * The marketing coupon row for one issuance batch of `count` customers.
 * `firstBatch` lets a SHARED code be used once - a code is one coupon.
 */
export function campaignCouponRow(
  c: Campaign,
  campaignRowId: string,
  count: number,
  opts: { firstBatch: boolean; today: string; random?: () => number },
): Record<string, unknown> & MarketingCouponDraft {
  const each = usesPerCustomer(c) ?? 1;
  const pct = c.offer.type === 'PERCENT';
  const brand = yijiBrandId(c);
  const code =
    c.distribution.codeType === 'SHARED' && opts.firstBatch && c.distribution.code
      ? c.distribution.code
      : newMarketingCouponCode(opts.random);
  const row = {
    code,
    title: c.name.en.slice(0, 60),
    description: `${c.id} - ${c.objective}${c.notes ? ` - ${c.notes}` : ''}`.slice(0, 500),
    discount_category: pct ? ('Percentage' as const) : ('Amount' as const),
    coupon_value: pct ? null : (c.offer.amountSar ?? null),
    coupon_percent: pct ? (c.offer.percent ?? null) : null,
    max_discount: pct ? (c.offer.maxDiscountSar ?? null) : null,
    order_minimum: c.rules.minOrderSar,
    valid_from: c.schedule.startDate,
    valid_to: couponValidTo(c, opts.today),
    total_uses: count * each,
    uses_per_customer: each,
    delivery_type: c.scope.orderTypes.map((t) => DELIVERY_WORD[t]).join(','),
    yiji_brand_id: brand,
    brand_name: brand ? (MARKETING_BRANDS.find((b) => b.yijiId === brand)?.name ?? null) : null,
    /* Narrower, never wider: either "no" in the campaign keeps the coupon off
       other offers and loyalty (the v1 coupon has one switch for both). */
    no_other_discounts: !c.stacking.combineWithOtherOffers || !c.stacking.combineWithLoyalty,
    audience: 'list' as const,
    recipient_count: count,
    submitted_at: null as string | null,
    campaign: campaignRowId,
  };
  return row;
}

/** The sender's own checks, run before anything is written. */
export function campaignCouponProblems(row: MarketingCouponDraft): string[] {
  return marketingCouponProblems(row);
}
