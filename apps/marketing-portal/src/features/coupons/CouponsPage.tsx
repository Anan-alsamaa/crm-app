import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MARKETING_COUPON_EDITABLE,
  isPercentageCategory,
  staffDisplayName,
  type MarketingCouponStatus,
} from '@yiji/shared-types';
import { Button, EmptyState, Spinner, cn, toast } from '@yiji/ui';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useCancelCoupon, useMarketingCoupons, type MarketingCoupon } from './api.js';
import { CouponFormDrawer } from './CouponFormDrawer.js';

const TONE: Record<MarketingCouponStatus, string> = {
  draft: 'bg-secondary text-muted-foreground',
  pending: 'bg-warning-tint text-foreground',
  approved: 'bg-sky-tint text-sky',
  rejected: 'bg-destructive/10 text-destructive',
  created: 'bg-success-tint text-success',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-secondary text-muted-foreground',
};

export function StatusBadge({ status }: { status: MarketingCouponStatus }) {
  const { t } = useTranslation();
  const label: Record<MarketingCouponStatus, string> = {
    draft: t('status.draft', { defaultValue: 'Draft' }),
    pending: t('status.pending', { defaultValue: 'Waiting for approval' }),
    approved: t('status.approved', { defaultValue: 'Approved - not on Yiji yet' }),
    rejected: t('status.rejected', { defaultValue: 'Rejected' }),
    created: t('status.created', { defaultValue: 'On Yiji' }),
    failed: t('status.failed', { defaultValue: 'Yiji refused it' }),
    cancelled: t('status.cancelled', { defaultValue: 'Cancelled' }),
  };
  return (
    <span
      className={cn(
        'whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium',
        TONE[status],
      )}
    >
      {label[status]}
    </span>
  );
}

/** "20 SAR" or "15% (max 30 SAR)". */
export function discountText(c: MarketingCoupon): string {
  return isPercentageCategory(c.discount_category)
    ? `${Number(c.coupon_percent)}% (max ${Number(c.max_discount)} SAR)`
    : `${Number(c.coupon_value)} SAR`;
}

export function CouponsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const q = useMarketingCoupons();
  const cancel = useCancelCoupon();
  const [editing, setEditing] = useState<MarketingCoupon | null>(null);
  const [open, setOpen] = useState(false);
  const rows = q.data ?? [];
  const mine = (c: MarketingCoupon) => c.user_created?.id === user?.id;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('coupons.title', { defaultValue: 'Marketing coupons' })}
        description={t('coupons.desc', {
          defaultValue:
            'Codes anyone can enter in the Yiji app. Prepare one, submit it, and a manager approves it before it is created on Yiji.',
        })}
        actions={
          <Button
            variant="brand"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            {t('coupons.new', { defaultValue: 'New coupon' })}
          </Button>
        }
      />
      <div className={PAGE_BODY}>
        {q.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner size={22} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('coupons.empty', { defaultValue: 'No marketing coupons yet' })}
            description={t('coupons.emptyHint', {
              defaultValue: 'Press "New coupon" to prepare the first one.',
            })}
          />
        ) : (
          <div className={cn(SECTION_CARD, 'overflow-x-auto')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  {[
                    t('coupons.code', { defaultValue: 'Code' }),
                    t('coupons.name', { defaultValue: 'Name customers see' }),
                    t('coupons.discountCol', { defaultValue: 'Discount' }),
                    t('coupons.validCol', { defaultValue: 'Valid' }),
                    t('coupons.usesCol', { defaultValue: 'Uses' }),
                    t('coupons.byCol', { defaultValue: 'Prepared by' }),
                    t('coupons.statusCol', { defaultValue: 'Status' }),
                    '',
                  ].map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-4 py-3 text-start font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const editable = mine(c) && MARKETING_COUPON_EDITABLE.includes(c.status);
                  return (
                    <tr key={c.id} className="border-t border-foreground/[0.06] align-top">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{c.code}</td>
                      <td className="px-4 py-3">
                        <div>{c.title}</div>
                        {c.brand_name && (
                          <div className="text-2xs text-muted-foreground">{c.brand_name}</div>
                        )}
                        {c.status === 'rejected' && c.decision_note && (
                          <div className="mt-1 text-2xs text-destructive">{c.decision_note}</div>
                        )}
                        {c.status === 'failed' && c.send_error && (
                          <div className="mt-1 text-2xs text-destructive">{c.send_error}</div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                        {discountText(c)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">
                        {String(c.valid_from).slice(0, 10)} → {String(c.valid_to).slice(0, 10)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                        {c.total_uses} · {c.uses_per_customer}/
                        {t('coupons.perCustomer', { defaultValue: 'customer' })}
                      </td>
                      <td className="px-4 py-3">{staffDisplayName(c.user_created, '—')}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-end">
                        {editable && (
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditing(c);
                                setOpen(true);
                              }}
                            >
                              {t('actions.edit', { defaultValue: 'Edit' })}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={cancel.isPending}
                              onClick={() =>
                                cancel.mutate(c, {
                                  onError: () =>
                                    toast.error(
                                      t('coupons.cancelFailed', {
                                        defaultValue: 'Could not cancel it',
                                      }),
                                    ),
                                })
                              }
                            >
                              {t('coupons.cancel', { defaultValue: 'Cancel coupon' })}
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <CouponFormDrawer open={open} coupon={editing} onClose={() => setOpen(false)} />
    </div>
  );
}
