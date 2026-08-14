import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn, formatRelative, Pill, Skeleton, Toolbar, ToolbarSpacer } from '@yiji/ui';
import { COUPON_APPROVAL_STATUSES, type CouponApprovalStatus } from '@yiji/shared-types';
import { useMyCouponRequests, type CouponRequestRow } from './api.js';

/**
 * Every coupon this agent has asked for, and what became of it.
 *
 * Opens on PENDING rather than on everything: the agent's live question is
 * "what am I still waiting on", and a list that starts with months of settled
 * history answers a question nobody asked.
 *
 * A rejection shows its reason on the row, not behind a click. An agent told
 * only "no" cannot answer the customer, which is the moment they need it.
 */
const TONE: Record<CouponApprovalStatus, 'warning' | 'success' | 'destructive'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'destructive',
};

function amount(r: CouponRequestRow, currency: string): string {
  const bits: string[] = [];
  if (r.coupon_value != null) {
    try {
      bits.push(
        new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(r.coupon_value),
      );
    } catch {
      bits.push(`${r.coupon_value} ${currency}`);
    }
  }
  if (r.coupon_percent != null) bits.push(`${r.coupon_percent}%`);
  return bits.join(' · ');
}

export function MyCouponsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const requests = useMyCouponRequests();
  const [view, setView] = useState<CouponApprovalStatus | 'all'>('pending');

  const rows = useMemo(() => {
    const all = requests.data ?? [];
    return view === 'all' ? all : all.filter((r) => r.status === view);
  }, [requests.data, view]);

  const count = (s: CouponApprovalStatus | 'all') =>
    s === 'all'
      ? (requests.data ?? []).length
      : (requests.data ?? []).filter((r) => r.status === s).length;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('coupons.title', { defaultValue: 'My coupons' })}
        </h1>
        <ToolbarSpacer />
        <span className="text-2xs text-muted-foreground">
          {t('coupons.waiting', {
            defaultValue: '{{n}} waiting on a supervisor',
            n: count('pending'),
          })}
        </span>
      </Toolbar>

      <div className="flex flex-wrap gap-1.5 border-b border-border bg-card px-4 py-2.5">
        {(
          ['pending', ...COUPON_APPROVAL_STATUSES.filter((s) => s !== 'pending'), 'all'] as const
        ).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setView(s)}
            aria-pressed={view === s}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-fast ease-out',
              view === s
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`coupons.status.${s}`, { defaultValue: s })}
            <span className="ms-1.5 tabular-nums opacity-70">{count(s)}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {requests.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-2xl" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {view === 'pending'
              ? t('coupons.noneWaiting', { defaultValue: 'Nothing waiting on a supervisor.' })
              : t('coupons.none', { defaultValue: 'No coupon requests here.' })}
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => r.ticket && navigate(`/tickets/${r.ticket.id}`)}
                  // Board card anatomy: code + status pill leading, the amount as
                  // the bold end-aligned numeral, meta underneath — hairline ring
                  // so the card holds its edge on the dark canvas.
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-2xl bg-card p-4 text-start shadow-soft ring-1 ring-foreground/[0.06] transition-colors duration-fast hover:bg-secondary/40"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-foreground">
                        {r.coupon_code ?? t('coupons.noCode', { defaultValue: 'no code' })}
                      </span>
                      <Pill tone={TONE[r.status]} size="sm">
                        {t(`coupons.status.${r.status}`, { defaultValue: r.status })}
                      </Pill>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {[r.contact?.name ?? r.contact?.phone, r.ticket?.subject]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <div className="shrink-0 text-end">
                    <div className="text-lg font-extrabold leading-none tabular-nums tracking-[-0.03em] text-foreground">
                      {amount(r, 'SAR') || '—'}
                    </div>
                    <div className="mt-1 text-2xs tabular-nums text-muted-foreground">
                      {formatRelative(r.decided_at ?? r.date_created)}
                    </div>
                  </div>
                  {r.status === 'rejected' && (
                    // On the row, not behind a click: this is what the agent
                    // has to tell the customer.
                    <p className="col-span-full mt-1 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs leading-relaxed text-foreground">
                      {r.decision_note ??
                        t('coupons.noReason', { defaultValue: 'No reason was given.' })}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
