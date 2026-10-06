import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { couponTermsFromDraft } from '../src/features/coupons/coupon-request-fields.js';

/**
 * Owner, 2026-10-06: an agent chose "No — do not deliver it on Yiji", but the
 * admin's approval card arrived unticked. Every coupon raised from a NEW
 * TICKET was created without `delivery_excluded` (production revisions): the
 * ticket dialog copied the form field by field and never learned the newer
 * fields. Both paths now share one mapping; these tests hold them to it.
 */
const draft = {
  code: 'OPS-TEST1234',
  compensation_reason: 'late',
  title: '0500000000',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  coupon_value: 9,
  coupon_percent: null,
  max_discount: 9,
  usage_limit: 1,
  valid_from: '2026-10-06',
  valid_to: '2026-11-06',
  item_name: 'Brookie',
  item_sku: 'SKU-1',
  no_other_discounts: true,
  delivery_excluded: true,
  delivery_excluded_reason: '  customer wants a refund  ',
} as never;

describe('couponTermsFromDraft', () => {
  it('carries "do not send to Yiji" and its reason', () => {
    expect(couponTermsFromDraft(draft)).toMatchObject({
      delivery_excluded: true,
      delivery_excluded_reason: 'customer wants a refund',
    });
  });

  it('carries the other fields the ticket path used to drop', () => {
    expect(couponTermsFromDraft(draft)).toMatchObject({
      no_other_discounts: true,
      item_sku: 'SKU-1',
    });
  });

  it('drops a stale reason when the coupon IS sent', () => {
    const t = couponTermsFromDraft({ ...(draft as object), delivery_excluded: false } as never);
    expect(t).toMatchObject({ delivery_excluded: false, delivery_excluded_reason: null });
  });
});

describe('every path that raises a coupon uses the shared mapping', () => {
  const read = (p: string) =>
    readFileSync(resolve(import.meta.dirname, '../src/features', p), 'utf8');

  it('the new-ticket dialog', () => {
    const src = read('tickets/CreateTicketDialog.tsx');
    expect(src).toMatch(/couponTermsFromDraft\(collectedCoupon\)/);
    // No private field-by-field copy left to fall behind again.
    expect(src).not.toMatch(/coupon_code: collectedCoupon\.code/);
  });

  it('the coupon dialog', () => {
    expect(read('coupons/CouponRequestDialog.tsx')).toMatch(/\.\.\.couponTermsFromDraft\(d\)/);
  });
});
