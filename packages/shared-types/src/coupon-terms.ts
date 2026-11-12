/**
 * A COUPON'S TERMS, CLEANED - one definition for the edit form and the worker
 * (owner, 2026-11-12: "find a reliable fix" for the edit form).
 *
 * Why this exists. The first in-place edit failed in three ways, all from the
 * form and the worker each reading a stored coupon their own way:
 *  - Directus returns DECIMAL columns as TEXT ("38.00000") while coupon_value
 *    comes back as a number: the form refused the text and Save stayed off;
 *  - older Private coupons have NO stored total limit: the form calculated
 *    one, so a save that changed nothing still looked like a change;
 *  - "3" and 3, "" and null, "2026-12-11" and "2026-12-11T00:00:00" compared
 *    as different values.
 *
 * Now a stored row becomes `CouponReplacementTerms` through `couponTermsOf`
 * only, and two sets of terms are compared through `couponTermsChanges` only.
 * The form's starting values, its "nothing changed" check, the job's
 * "version I opened" stamp and the worker's comparison all use these, so
 * they cannot disagree.
 *
 * Pure functions only.
 */
import {
  effectiveTotalLimit,
  isGeneralCouponType,
  isPercentageCategory,
  privateTotalLimit,
} from './coupon-request.js';
import type { CouponReplacementTerms } from './coupon-replace.js';

/** The columns an edit may change - never the code, the customer or the ticket. */
export const EDITABLE_COUPON_TERMS = [
  'title',
  'issuing_side',
  'delivery_type',
  'coupon_type',
  'discount_category',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'valid_from',
  'valid_to',
  'usage_limit',
  'total_discount_limit',
  'item_name',
  'item_sku',
  'no_other_discounts',
  'reason',
] as const;
export type EditableCouponTerm = (typeof EDITABLE_COUPON_TERMS)[number];

/** A stored or typed number: text, number or empty, as a number or null. */
export function couponNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const optionalText = (v: unknown): string | null => text(v) || null;
const day = (v: unknown): string => text(v).slice(0, 10);

/**
 * A coupon row (as Directus returns it) or the form's terms, cleaned:
 * numbers are numbers, dates are YYYY-MM-DD, blanks are null, and the money
 * columns follow the category the way they are stored (an amount has no
 * percent and its ceiling IS the amount; a percentage has no amount).
 * A Private coupon without a stored total limit gets the calculated one (uses
 * x maximum discount) - the same number the push sent to Yiji.
 */
export function couponTermsOf(row: Record<string, unknown>): CouponReplacementTerms {
  const pct = isPercentageCategory(text(row.discount_category));
  const value = pct ? null : couponNumber(row.coupon_value);
  const percent = pct ? couponNumber(row.coupon_percent) : null;
  const max = pct ? couponNumber(row.max_discount) : value;
  const usage = couponNumber(row.usage_limit);
  const base = {
    title: text(row.title),
    issuing_side: text(row.issuing_side),
    delivery_type: text(row.delivery_type),
    coupon_type: text(row.coupon_type),
    discount_category: text(row.discount_category),
    coupon_value: value,
    coupon_percent: percent,
    max_discount: max,
    valid_from: day(row.valid_from),
    valid_to: day(row.valid_to),
    usage_limit: usage ?? 0,
    item_name: optionalText(row.item_name),
    item_sku: optionalText(row.item_sku),
    no_other_discounts: row.no_other_discounts === true,
    reason: optionalText(row.reason),
  };
  const stored = couponNumber(row.total_discount_limit);
  const total =
    stored !== null && stored > 0
      ? stored
      : isGeneralCouponType(base.coupon_type)
        ? null
        : privateTotalLimit(base);
  return { ...base, total_discount_limit: total };
}

/** The edited terms' fields that differ from `before`, compared cleaned. */
export function couponTermsChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): EditableCouponTerm[] {
  const a = couponTermsOf(before) as unknown as Record<string, unknown>;
  const b = couponTermsOf(after) as unknown as Record<string, unknown>;
  return EDITABLE_COUPON_TERMS.filter((k) => (a[k] ?? null) !== (b[k] ?? null));
}

/**
 * A stable fingerprint of a coupon's terms: the "version" the editor opened.
 * The worker refuses the edit when the coupon's terms no longer match it -
 * someone else changed the coupon in the meantime (owner, 2026-11-12: the
 * last save must never silently overwrite another).
 */
export function couponTermsVersion(row: Record<string, unknown>): string {
  const t = couponTermsOf(row) as unknown as Record<string, unknown>;
  return JSON.stringify(EDITABLE_COUPON_TERMS.map((k) => t[k] ?? null));
}

/**
 * The edited terms as they will be STORED. For a Private coupon the total
 * limit follows uses x maximum discount - but only when one of those changed:
 * an approving admin's own limit survives an edit of, say, the dates.
 */
export function editedCouponTerms(
  before: Record<string, unknown>,
  edited: CouponReplacementTerms,
): CouponReplacementTerms {
  const was = couponTermsOf(before);
  const now = couponTermsOf(edited as unknown as Record<string, unknown>);
  if (isGeneralCouponType(now.coupon_type)) return now;
  const moneyMoved =
    was.coupon_value !== now.coupon_value ||
    was.coupon_percent !== now.coupon_percent ||
    was.max_discount !== now.max_discount ||
    was.usage_limit !== now.usage_limit ||
    was.discount_category !== now.discount_category ||
    was.coupon_type !== now.coupon_type;
  return {
    ...now,
    total_discount_limit: moneyMoved
      ? privateTotalLimit(now)
      : (was.total_discount_limit ?? effectiveTotalLimit(now)),
  };
}
