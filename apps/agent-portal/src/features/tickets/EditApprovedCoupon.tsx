import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Pill } from '@yiji/ui';
import { couponDecision } from '@yiji/shared-types';
import type { CouponRequestRow } from '../coupons/api.js';

/**
 * EDITING AN APPROVED COUPON LEFT THE TICKET (owner, 2026-11-15): "we want it
 * in the Coupon approvals page in the admin portal". The ticket now only SHOWS
 * what happened to a coupon - which side of an edit-after-approval it is.
 */

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
