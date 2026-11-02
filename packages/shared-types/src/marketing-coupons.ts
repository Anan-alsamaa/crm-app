/**
 * MARKETING COUPONS (owner, 2026-11-02: the Marketing portal).
 *
 * A marketing coupon is a CODE anyone may enter in the Yiji app, up to a total
 * number of uses - not a compensation for one customer. It is prepared by a
 * marketing user, approved by a marketing MANAGER (never the same person), and
 * only then created on Yiji, exactly once.
 *
 * Once created it is never edited on Yiji: an edit drops the coupon out of
 * Yiji's IssuedCopouns report (2026-11-01). Everything is settled while the
 * coupon is still a draft.
 */
import {
  couponWindow,
  generateCouponCode,
  isPercentageCategory,
  YIJI_COUPON_CATEGORY,
  yijiCouponEnum,
  yijiDeliveryTypes,
  yijiIssuingSideId,
  YIJI_ORDER_MAXIMUM,
} from './coupon-request.js';
import { normalizePhone } from './phone.js';

/**
 * Where a marketing coupon is.
 *
 *   draft     - being prepared; only its author edits it
 *   pending   - submitted; waiting for a manager
 *   approved  - a manager said yes; waiting to be created on Yiji
 *   rejected  - a manager said no (with a note); the author may fix and resubmit
 *   created   - on Yiji, with Yiji's coupon id. Final.
 *   failed    - Yiji refused it; the reason is kept. Final until looked at.
 *   cancelled - withdrawn before it was created. Final.
 */
export const MARKETING_COUPON_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  /** A list coupon: on Yiji, still being given to the customers on its list. */
  'sending',
  'created',
  'failed',
  'cancelled',
] as const;
export type MarketingCouponStatus = (typeof MARKETING_COUPON_STATUSES)[number];

/** Statuses in which the author may still change the coupon. */
export const MARKETING_COUPON_EDITABLE: readonly MarketingCouponStatus[] = ['draft', 'rejected'];

/** Every marketing coupon is issued by Marketing ("MKT - Activity" on Yiji). */
export const MARKETING_ISSUING_SIDE = 'Marketing';

/**
 * The brands a marketing coupon can be limited to, with YIJI's brand ids -
 * read off Yiji's own restaurant list (2026-11-01). Empty choice = every brand.
 */
export const MARKETING_BRANDS: readonly { name: string; yijiId: number }[] = [
  { name: 'La Casa Pasta', yijiId: 1 },
  { name: 'Okashi', yijiId: 3 },
  { name: "Chick 'N' Dip", yijiId: 81 },
  { name: 'Poshak', yijiId: 1004 },
];

/** A fresh code: `MKT-` and eight characters from the unambiguous alphabet. */
export function newMarketingCouponCode(random: () => number = Math.random): string {
  return generateCouponCode(random, 'MKT', 8);
}

export interface MarketingCouponDraft {
  code: string;
  /** The name a customer sees in the app. */
  title: string;
  /** Why it exists - internal, sent as Yiji's reason. */
  description?: string | null;
  discount_category: 'Amount' | 'Percentage';
  coupon_value?: number | string | null;
  coupon_percent?: number | string | null;
  max_discount?: number | string | null;
  order_minimum?: number | string | null;
  valid_from: string;
  valid_to: string;
  /** Total redemptions across everyone (Yiji `reachLimit`). */
  total_uses: number | string;
  /** Redemptions per customer (Yiji `limitForUser`). */
  uses_per_customer: number | string;
  /** Stored like a compensation coupon's: '' or 'All' = every channel. */
  delivery_type?: string | null;
  /** Yiji's brand id, or null for every brand. */
  yiji_brand_id?: number | string | null;
  no_other_discounts?: boolean | null;
  /**
   * WHO may use it: `code` = anyone who types the code (General); `list` = only
   * the customers on its list, each given it in their wallet (Private). A bulk
   * send is a `list` coupon.
   */
  audience?: 'code' | 'list' | null;
}

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * What is wrong with a draft, in words a marketing user can act on. Empty when
 * it may be submitted. The same check runs before approval and before sending,
 * so a coupon that slipped past the form still cannot reach Yiji.
 */
export function marketingCouponProblems(d: MarketingCouponDraft): string[] {
  const out: string[] = [];
  if (!/^MKT-[A-Z0-9]{4,16}$/.test((d.code ?? '').trim()))
    out.push('The code must start with MKT- followed by 4 to 16 letters or digits.');
  if (!(d.title ?? '').trim()) out.push('Give the coupon a name customers will see.');
  const pct = isPercentageCategory(d.discount_category);
  if (pct) {
    const p = n(d.coupon_percent);
    if (p === null || p <= 0 || p > 100) out.push('The percentage must be between 1 and 100.');
    const cap = n(d.max_discount);
    if (cap === null || cap <= 0) out.push('A percentage coupon needs a maximum discount in SAR.');
  } else {
    const v = n(d.coupon_value);
    if (v === null || v <= 0) out.push('The amount must be more than 0 SAR.');
  }
  const min = n(d.order_minimum);
  if (min !== null && min < 0) out.push('The minimum order cannot be negative.');
  const total = n(d.total_uses);
  const each = n(d.uses_per_customer);
  if (total === null || !Number.isInteger(total) || total < 1)
    out.push('Total uses must be a whole number of at least 1.');
  if (each === null || !Number.isInteger(each) || each < 1)
    out.push('Uses per customer must be a whole number of at least 1.');
  if (total !== null && each !== null && each > total)
    out.push('Uses per customer cannot be more than the total uses.');
  const from = (d.valid_from ?? '').slice(0, 10);
  const to = (d.valid_to ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    out.push('Choose the first and last day the coupon can be used.');
  else if (to < from) out.push('The last day cannot be before the first day.');
  return out;
}

/**
 * The body for Yiji's `POST /api/Coupon/AddCoupon`: a GENERAL coupon, held by
 * nobody, redeemable by its code up to `total_uses` times.
 *
 * No `restaurantId`, ever: a marketing code works at every branch of its
 * brand (or of every brand), and a restaurant on a coupon keeps it out of
 * Yiji's monthly report.
 */
export function marketingCouponPayload(d: MarketingCouponDraft): Record<string, unknown> {
  const pct = isPercentageCategory(d.discount_category);
  const window = couponWindow(d.valid_from.slice(0, 10), d.valid_to.slice(0, 10));
  const each = n(d.uses_per_customer) ?? 1;
  const brand = n(d.yiji_brand_id);
  const deliveryTypes = yijiDeliveryTypes(d.delivery_type);
  const side = yijiIssuingSideId(MARKETING_ISSUING_SIDE);
  const cap = n(d.max_discount);
  const reason = (d.description ?? '').trim() || d.title.trim();
  return {
    id: 0,
    name: d.title.trim(),
    code: d.code.trim(),
    compensationReason: reason,
    compensation: reason,
    // General for a public code; Private for a list - only those given it.
    type: d.audience === 'list' ? 1 : 0,
    category: yijiCouponEnum(YIJI_COUPON_CATEGORY, d.discount_category) ?? (pct ? 0 : 1),
    discount: pct ? 0 : (n(d.coupon_value) ?? 0),
    discountPercentage: pct ? (n(d.coupon_percent) ?? 0) : 0,
    ...(cap !== null ? { maximumDiscount: cap } : {}),
    reachLimit: n(d.total_uses) ?? 1,
    limitForUser: each,
    monthlyReachLimit: each,
    orderMinimum: n(d.order_minimum) ?? 0,
    orderMaximum: YIJI_ORDER_MAXIMUM,
    dontApplyLoyality: d.no_other_discounts === true,
    dontApplyOffer: d.no_other_discounts === true,
    posDisountCode: 0,
    ...(side != null ? { issuingSideId: side } : {}),
    ...(deliveryTypes ? { deliveryTypes } : {}),
    ...(brand !== null && brand > 0 ? { brandId: brand } : {}),
    saturday: true,
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    activationDate: window.from,
    expirationDate: window.to,
    activationDateTime: window.from,
    expirationDateTime: window.to,
    assignee: [],
  };
}

/** The most customers one bulk send may carry (owner's paced sender: hours, not days). */
export const MARKETING_LIST_MAX = 20_000;

/**
 * Read a pasted or uploaded list of phone numbers - one per line, or CSV with
 * the number in any column. Every number is put in the CRM's one canonical
 * form (05XXXXXXXX); anything that is not a Saudi mobile is reported, never
 * guessed at; repeats are counted and kept once.
 */
export function parseRecipientList(text: string): {
  phones: string[];
  invalid: string[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const invalid: string[] = [];
  let duplicates = 0;
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const cell = cells.find((c) => /\d{8,}/.test(c.replace(/\D/g, '')));
    if (!cell) {
      // A header row or an empty line is not a mistake worth reporting.
      if (line.trim() && /\d/.test(line)) invalid.push(line.trim().slice(0, 40));
      continue;
    }
    const phone = normalizePhone(cell);
    if (!/^05\d{8}$/.test(phone)) {
      invalid.push(cell.slice(0, 40));
      continue;
    }
    if (seen.has(phone)) duplicates += 1;
    else seen.add(phone);
  }
  return { phones: [...seen], invalid, duplicates };
}
