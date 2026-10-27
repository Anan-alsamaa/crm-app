import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Pill, toast } from '@yiji/ui';
import {
  couponDecision,
  couponEditBlock,
  couponIsExpired,
  defaultCouponDates,
  isPercentageCategory,
  type CouponReplacementTerms,
  type CouponRequestDraft,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useReplaceTicketCoupon, type CouponRequestRow } from '../coupons/api.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';

/**
 * EDIT AN APPROVED COUPON FROM ITS TICKET (owner, 2026-10-27).
 *
 * For whoever holds `edit_approved_coupons` (WeCare Supervisor / WeCare Admin /
 * Administrator by default). Offered only when the coupon CAN be edited from
 * what the screen already knows - approved, not removed, not replaced, not
 * known to be used - and only where the replacement fields exist (`replaces`
 * was read). "Was it used?" is asked by the workers for this one coupon after
 * Save, never by this screen.
 */
export function canOfferCouponEdit(c: CouponRequestRow, allowed: boolean): boolean {
  return (
    allowed &&
    c.replaces !== undefined &&
    couponEditBlock({
      status: c.status,
      removal_status: c.removal_status ?? null,
      replaced_by: c.replaced_by ?? null,
    }) === null
  );
}

/** The dialog's validated draft as replacement terms. */
export function draftToTerms(d: CouponRequestDraft): CouponReplacementTerms {
  const pct = isPercentageCategory(d.discount_category);
  return {
    title: d.title,
    issuing_side: d.issuing_side,
    delivery_type: d.delivery_type,
    coupon_type: d.coupon_type,
    discount_category: d.discount_category,
    valid_from: d.valid_from,
    valid_to: d.valid_to,
    coupon_value: pct ? null : (d.coupon_value ?? null),
    coupon_percent: pct ? (d.coupon_percent ?? null) : null,
    max_discount: pct ? d.max_discount : (d.coupon_value ?? null),
    usage_limit: d.usage_limit,
    item_name: d.item_name ?? null,
    item_sku: d.item_sku ?? null,
    no_other_discounts: d.no_other_discounts,
    reason: d.compensation_reason,
  };
}

/** "Replaced by X" / "Replaces X" / "Edit not applied" on a ticket's coupon. */
export function CouponReplacementPill({ c }: { c: CouponRequestRow }): JSX.Element | null {
  const { t } = useTranslation();
  if (c.replaced_by) {
    return (
      <Pill tone="neutral" size="sm">
        {t('coupons.replacedBy', {
          defaultValue: 'Replaced by {{code}}',
          code: c.replaced_by.coupon_code ?? '—',
        })}
      </Pill>
    );
  }
  if (c.replaces) {
    return couponDecision(c.status) === 'rejected' ? (
      <Pill tone="warning" size="sm">
        {t('coupons.replaceAbandoned', {
          defaultValue: 'Edit of {{code}} not applied',
          code: c.replaces.coupon_code ?? '—',
        })}
      </Pill>
    ) : (
      <Pill tone="highlight" size="sm">
        {t('coupons.replaces', {
          defaultValue: 'Replaces {{code}}',
          code: c.replaces.coupon_code ?? '—',
        })}
      </Pill>
    );
  }
  return null;
}

export function EditApprovedCouponButton({ coupon }: { coupon: CouponRequestRow }): JSX.Element {
  const { t } = useTranslation();
  const { user } = useAuth();
  const replace = useReplaceTicketCoupon();
  const [open, setOpen] = useState(false);
  const expired = couponIsExpired(coupon.valid_to, new Date());
  /* An expired coupon is replaced by a VALID one: fresh dates to start from. */
  const dates = expired
    ? defaultCouponDates(new Date())
    : { valid_from: coupon.valid_from ?? '', valid_to: coupon.valid_to ?? '' };

  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t('coupons.editCoupon', { defaultValue: 'Edit coupon' })}
      </Button>
      {open && (
        <CouponRequestDialog
          open
          onClose={() => (replace.isPending ? undefined : setOpen(false))}
          editingId={coupon.id}
          replaceOf={{
            code: coupon.coupon_code,
            expiredOn: expired ? (coupon.valid_to ?? '').slice(0, 10) : null,
          }}
          saving={replace.isPending}
          contactId={coupon.contact?.id ?? null}
          customerPhone={coupon.contact?.phone ?? coupon.customer_phone ?? null}
          description={coupon.reason ?? null}
          brandId={coupon.brand_id ?? null}
          restaurantId={coupon.restaurant_id ?? null}
          requestedBy={coupon.requested_by?.id ?? null}
          initial={{
            title: coupon.title ?? '',
            // Placeholder only: a NEW code is generated on save.
            code: coupon.coupon_code || 'REPLACE',
            issuing_side: coupon.issuing_side ?? '',
            delivery_type: coupon.delivery_type ?? 'All',
            coupon_type: coupon.coupon_type ?? 'Private',
            discount_category: coupon.discount_category ?? 'Amount',
            valid_from: dates.valid_from.slice(0, 10),
            valid_to: dates.valid_to.slice(0, 10),
            coupon_value: coupon.coupon_value,
            coupon_percent: coupon.coupon_percent,
            max_discount: coupon.max_discount ?? 0,
            usage_limit: coupon.usage_limit ?? 1,
            compensation_reason: coupon.reason ?? '',
            item_name: coupon.item_name,
            item_sku: coupon.item_sku,
            no_other_discounts: coupon.no_other_discounts ?? false,
            delivery_excluded: coupon.delivery_excluded === true,
            delivery_excluded_reason: coupon.delivery_excluded_reason ?? '',
          }}
          onSave={async (d, extra) => {
            try {
              const r = await replace.mutateAsync({
                /* The form's "send on the app" answer rides with the edit. */
                old: {
                  ...coupon,
                  delivery_excluded: d.delivery_excluded,
                  delivery_excluded_reason: d.delivery_excluded_reason ?? null,
                },
                terms: draftToTerms(d),
                reason: extra?.changeReason ?? '',
                editorId: user?.id ?? null,
              });
              if (r.state === 'done') {
                toast.success(
                  t('coupons.replaceDone', {
                    defaultValue:
                      'Coupon edited — {{code}} replaces {{old}} and is on its way to the customer.',
                    code: r.code,
                    old: coupon.coupon_code ?? '—',
                  }),
                );
              } else if (r.state === 'refused') {
                toast.error(
                  t('coupons.replaceRefused', { defaultValue: 'The coupon was not changed' }),
                  { description: r.note ?? undefined, durationMs: 0 },
                );
              } else {
                toast.success(
                  t('coupons.replaceWorking', {
                    defaultValue:
                      'Edit sent — still swapping the coupon in the customer’s app. The ticket updates when it is done.',
                  }),
                );
              }
              setOpen(false);
            } catch (err) {
              toast.error(
                t('coupons.replaceFailed', { defaultValue: 'Could not edit this coupon' }),
                { description: err instanceof Error ? err.message : undefined },
              );
            }
          }}
        />
      )}
    </>
  );
}
