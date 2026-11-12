import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Pill, toast } from '@yiji/ui';
import {
  couponDecision,
  couponEditBlock,
  couponIsExpired,
  couponTermsChanges,
  couponTermsOf,
  couponTermsVersion,
  defaultCouponDates,
  editedCouponTerms,
  isPercentageCategory,
  type CouponReplacementTerms,
  type CouponRequestDraft,
} from '@yiji/shared-types';
import { useEditTicketCoupon, type CouponRequestRow } from '../coupons/api.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';
import { storedCouponType, storedTotalLimit } from '../coupons/coupon-request-fields.js';
import { CouponMaintenancePill } from '../coupons/CouponMaintenance.js';
import { useCouponsUnderMaintenance } from '../coupons/maintenance.js';

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
    /* An edit of it is still running (switched off on Yiji). */
    c.edit_state !== 'frozen' &&
    couponEditBlock({
      status: c.status,
      removal_status: c.removal_status ?? null,
      replaced_by: c.replaced_by ?? null,
      yiji_used_order: c.yiji_used_order ?? null,
    }) === null
  );
}

/** A stored amount as a number: Directus sends DECIMAL columns as text. */
export function amountOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The dialog's validated draft as replacement terms. */
export function draftToTerms(d: CouponRequestDraft): CouponReplacementTerms {
  const pct = isPercentageCategory(d.discount_category);
  return {
    title: d.title,
    issuing_side: d.issuing_side,
    delivery_type: d.delivery_type,
    coupon_type: storedCouponType(d),
    discount_category: d.discount_category,
    valid_from: d.valid_from,
    valid_to: d.valid_to,
    coupon_value: pct ? null : (d.coupon_value ?? null),
    coupon_percent: pct ? (d.coupon_percent ?? null) : null,
    max_discount: pct ? d.max_discount : (d.coupon_value ?? null),
    usage_limit: d.usage_limit,
    total_discount_limit: storedTotalLimit(d),
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
  const replace = useEditTicketCoupon();
  const couponsPaused = useCouponsUnderMaintenance();
  const [open, setOpen] = useState(false);
  const expired = couponIsExpired(coupon.valid_to, new Date());
  /* ONE cleaned reading of the stored coupon (owner, 2026-11-12): the form's
     starting values, its "nothing changed" check and the version the worker
     checks all come from it - text amounts ("3.00000") and older coupons
     without a stored limit can no longer block Save or look like a change. */
  const stored = coupon as unknown as Record<string, unknown>;
  const was = couponTermsOf(stored);
  const basedOn = couponTermsVersion(stored);
  /* An expired coupon gets VALID dates to start from (the same coupon, edited). */
  const dates = expired
    ? defaultCouponDates(new Date())
    : { valid_from: coupon.valid_from ?? '', valid_to: coupon.valid_to ?? '' };

  /* Coupons under maintenance (owner, 2026-11-04): an edit sends a new coupon. */
  if (couponsPaused) return <CouponMaintenancePill />;
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
            // The SAME code: an edit changes this coupon in place (2026-11-11).
            code: coupon.coupon_code || '',
            issuing_side: coupon.issuing_side ?? '',
            delivery_type: coupon.delivery_type ?? 'All',
            coupon_type: coupon.coupon_type ?? 'Private',
            discount_category: coupon.discount_category ?? 'Amount',
            valid_from: dates.valid_from.slice(0, 10),
            valid_to: dates.valid_to.slice(0, 10),
            /* Directus returns DECIMAL columns as text ("3.00000"): the form's
               number fields refused them and Save stayed blocked ("Expected
               number, received string") - found testing on staging, 2026-11-12. */
            coupon_value: was.coupon_value ?? null,
            coupon_percent: was.coupon_percent ?? null,
            max_discount: was.max_discount ?? 0,
            usage_limit: was.usage_limit || 1,
            total_discount_limit: was.total_discount_limit ?? null,
            compensation_reason: coupon.reason ?? '',
            item_name: coupon.item_name,
            item_sku: coupon.item_sku,
            no_other_discounts: coupon.no_other_discounts ?? false,
            delivery_excluded: coupon.delivery_excluded === true,
            delivery_excluded_reason: coupon.delivery_excluded_reason ?? '',
          }}
          editBlock={(d) =>
            couponTermsChanges(stored, editedCouponTerms(stored, draftToTerms(d)) as never)
              .length === 0
              ? t('coupons.editNothingChanged', {
                  defaultValue: 'Nothing changed yet - change a value to save.',
                })
              : null
          }
          onSave={async (d, extra) => {
            try {
              const r = await replace.mutateAsync({
                couponId: coupon.id,
                terms: editedCouponTerms(stored, draftToTerms(d)),
                reason: extra?.changeReason ?? '',
                basedOn,
              });
              if (r.state === 'done') {
                toast.success(
                  t('coupons.editDone', {
                    defaultValue:
                      'Coupon {{code}} edited — the customer sees the new values on the same coupon.',
                    code: coupon.coupon_code ?? '—',
                  }),
                );
              } else if (r.state === 'refused') {
                toast.error(
                  t('coupons.replaceRefused', { defaultValue: 'The coupon was not changed' }),
                  { description: r.note ?? undefined, durationMs: 0 },
                );
              } else {
                toast.success(
                  t('coupons.editWorking', {
                    defaultValue:
                      'Edit sent — still updating the coupon on Yiji. The ticket updates when it is done.',
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
