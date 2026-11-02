import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { marketingCouponProblems, staffDisplayName } from '@yiji/shared-types';
import { Button, EmptyState, Spinner, Textarea, cn, toast } from '@yiji/ui';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useDecideCoupon, useMarketingCoupons, type MarketingCoupon } from '../coupons/api.js';
import { discountText } from '../coupons/CouponsPage.js';

/**
 * The manager's queue (owner, 2026-11-02): marketing work waits here until a
 * marketing manager approves it, and nothing reaches a customer before that.
 * A manager never decides their own coupon - the page says so, and Directus
 * refuses it regardless.
 */
export function ApprovalsPage() {
  const { t } = useTranslation();
  const q = useMarketingCoupons(['pending']);
  const rows = q.data ?? [];
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('approvals.title', { defaultValue: 'Approvals' })}
        description={t('approvals.desc', {
          defaultValue:
            'Marketing coupons wait here until a marketing manager approves them. Nothing reaches a customer before that.',
        })}
      />
      <div className={PAGE_BODY}>
        {q.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner size={22} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('approvals.empty', { defaultValue: 'Nothing is waiting for approval' })}
            description={t('approvals.emptyHint', {
              defaultValue: 'When someone submits a coupon, it will appear here.',
            })}
          />
        ) : (
          <div className="space-y-4">
            {rows.map((c) => (
              <PendingCard key={c.id} coupon={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingCard({ coupon: c }: { coupon: MarketingCoupon }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const decide = useDecideCoupon();
  const [note, setNote] = useState('');
  const own = c.user_created?.id === user?.id;
  const problems = marketingCouponProblems(c);
  const go = (approve: boolean) => {
    if (!approve && !note.trim()) {
      toast.error(
        t('approvals.noteNeeded', { defaultValue: 'Say why, so the author can fix it.' }),
      );
      return;
    }
    decide.mutate(
      { coupon: c, approve, note, userId: user?.id ?? '' },
      {
        onSuccess: () =>
          toast.success(
            approve
              ? t('approvals.approved', { defaultValue: 'Approved' })
              : t('approvals.rejected', { defaultValue: 'Rejected' }),
          ),
        onError: () =>
          toast.error(t('approvals.failed', { defaultValue: 'Could not record that decision' })),
      },
    );
  };
  const fact = (label: string, value: string) => (
    <div className="rounded-xl bg-secondary/60 px-3 py-2">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );

  return (
    <div className={cn(SECTION_CARD, 'p-5')}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-sm font-semibold">{c.code}</span>
        <span className="text-md font-semibold">{c.title}</span>
        <span className="text-xs text-muted-foreground">
          {t('approvals.by', { defaultValue: 'Prepared by' })}{' '}
          {staffDisplayName(c.user_created, '—')}
        </span>
      </div>
      {c.description && <p className="mt-2 text-sm text-muted-foreground">{c.description}</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {fact(t('coupons.discountCol', { defaultValue: 'Discount' }), discountText(c))}
        {fact(
          t('coupons.validCol', { defaultValue: 'Valid' }),
          `${String(c.valid_from).slice(0, 10)} → ${String(c.valid_to).slice(0, 10)}`,
        )}
        {c.audience === 'list'
          ? fact(
              t('approvals.list', { defaultValue: 'Customers on the list' }),
              String(c.recipient_count ?? 0),
            )
          : fact(
              t('coupons.total', { defaultValue: 'Total uses (everyone)' }),
              String(c.total_uses),
            )}
        {fact(
          t('coupons.each', { defaultValue: 'Uses per customer' }),
          String(c.uses_per_customer),
        )}
        {fact(
          t('coupons.brand', { defaultValue: 'Brand' }),
          c.brand_name ?? t('coupons.allBrands', { defaultValue: 'Every brand' }),
        )}
        {fact(
          t('coupons.minimum', { defaultValue: 'Minimum order (SAR, optional)' }),
          c.order_minimum ? `${Number(c.order_minimum)} SAR` : '—',
        )}
      </div>
      {problems.length > 0 && (
        <ul className="mt-4 list-disc space-y-1 rounded-xl bg-destructive/10 px-6 py-3 text-sm text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {own ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {t('approvals.own', {
            defaultValue: 'You prepared this coupon, so another manager has to decide it.',
          })}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Textarea
            rows={1}
            className="sm:flex-1"
            placeholder={t('approvals.notePh', {
              defaultValue: 'Note (required to reject)',
            })}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="brand"
              disabled={decide.isPending || problems.length > 0}
              onClick={() => go(true)}
            >
              {t('approvals.approve', { defaultValue: 'Approve' })}
            </Button>
            <Button
              variant="destructive-soft"
              disabled={decide.isPending}
              onClick={() => go(false)}
            >
              {t('approvals.reject', { defaultValue: 'Reject' })}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
