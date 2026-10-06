import { compensationFlag, type CouponRequestDraft } from '@yiji/shared-types';

/**
 * THE ONE PLACE a completed coupon form becomes the fields of a coupon request.
 *
 * Owner, 2026-10-06: an agent chose "No — do not deliver it on Yiji", yet the
 * approval card in the admin portal arrived UNTICKED and the admin had to tick
 * it by hand at night. Production's revision history showed why: every coupon
 * raised from a NEW TICKET was created without `delivery_excluded` at all,
 * while coupons raised from the coupon dialog itself carried it. The form's
 * values were copied field by field in two places, and the ticket's copy had
 * never been taught the newer fields (`delivery_excluded`, its reason,
 * `no_other_discounts`, `item_sku`).
 *
 * Both callers now spread THIS, so a field added to the form reaches every
 * path or none — `coupon-request-fields.test.ts` enforces it.
 */
export function couponTermsFromDraft(d: CouponRequestDraft) {
  const pct = d.discount_category === 'Percentage';
  return {
    coupon_code: d.code,
    // The category decides WHICH money field carries the number, AS ENTERED.
    coupon_value: pct ? null : (d.coupon_value ?? null),
    coupon_percent: pct ? (d.coupon_percent ?? null) : null,
    // Requesting a coupon IS the compensation decision.
    compensation: compensationFlag(true),
    title: d.title,
    issuing_side: d.issuing_side,
    delivery_type: d.delivery_type,
    coupon_type: d.coupon_type,
    discount_category: d.discount_category,
    valid_from: d.valid_from,
    valid_to: d.valid_to,
    max_discount: d.max_discount,
    usage_limit: d.usage_limit,
    brand_id: d.brand_id ?? null,
    restaurant_id: d.restaurant_id ?? null,
    item_name: d.item_name ?? null,
    item_sku: d.item_sku ?? null,
    no_other_discounts: d.no_other_discounts,
    /* Whether it ever reaches the Yiji app. The reason rides along only when it
       is actually withheld — a reason on a coupon that IS delivered would read
       as a contradiction on the approval card. */
    delivery_excluded: d.delivery_excluded === true,
    delivery_excluded_reason: d.delivery_excluded
      ? d.delivery_excluded_reason?.trim() || null
      : null,
  };
}
