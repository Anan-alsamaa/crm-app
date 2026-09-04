import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  cn,
  EmptyState,
  formatRelative,
  Pill,
  Skeleton,
  TicketIcon,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import {
  COUPON_APPROVAL_STATUSES,
  couponDecision,
  type CouponApprovalStatus,
} from '@yiji/shared-types';
import { useMyCouponRequests, type CouponRequestRow } from './api.js';

/**
 * Every compensation/coupon request from EVERY agent, and what became of each —
 * the one shared source of truth for compensation, so an agent answering a
 * customer can see a colleague's request too.
 *
 * Opens on PENDING rather than on everything: the live question is "what is
 * still waiting", and a list that starts with months of settled history answers
 * a question nobody asked.
 *
 * A rejection shows its reason on the row, not behind a click. An agent told
 * only "no" cannot answer the customer, which is the moment they need it.
 */
// Wider than CouponApprovalStatus on purpose: the push worker moves a row to
// `assigned` once Yiji actually has the coupon, and that state still renders.
const TONE: Record<string, 'warning' | 'success' | 'destructive'> = {
  pending: 'warning',
  approved: 'success',
  assigned: 'success',
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
  const [search, setSearch] = useState('');

  // "approved" is every APPROVED decision — 'edited' and 'assigned' included.
  // Naming only 'assigned' here left an amended approval in no tab at all.
  const inView = (s: string, v: CouponApprovalStatus | 'all') =>
    v === 'all' || s === v || (v === 'approved' && couponDecision(s) === 'approved');

  const rows = useMemo(() => {
    const all = requests.data ?? [];
    const byStatus = all.filter((r) => inView(r.status, view));
    const q = search.trim().toLowerCase();
    if (!q) return byStatus;
    // One box over the facts an agent actually holds when a customer calls:
    // the coupon type/code, the order number, the phone. Name and requester
    // ride along because excluding them would only surprise.
    return byStatus.filter((r) =>
      [
        r.coupon_type,
        r.coupon_code,
        r.discount_category,
        r.ticket?.order_id,
        r.contact?.phone,
        r.contact?.name,
        r.requested_by?.first_name,
        r.requested_by?.email,
      ].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
  }, [requests.data, view, search]);

  const count = (s: CouponApprovalStatus | 'all') =>
    (requests.data ?? []).filter((r) => inView(r.status, s)).length;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('coupons.titleAll', { defaultValue: 'Compensation requests' })}
        </h1>
        <ToolbarSpacer />
        <span className="text-2xs text-muted-foreground">
          {t('coupons.waiting', {
            defaultValue: '{{n}} waiting on a supervisor',
            n: count('pending'),
          })}
        </span>
      </Toolbar>

      {/* The filter band keeps its full-bleed hairline, but the pills sit in
          the same centered column as the cards below — at 1920px a cluster of
          pills pinned to the far edge belonged to nothing. */}
      <div className="border-b border-border bg-card px-4 py-2.5">
        <div className="mx-auto mb-2 w-full max-w-3xl">
          <input
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder={t('coupons.searchPlaceholder', {
              defaultValue: 'Search by coupon type, code, order ID or customer phone…',
            })}
            aria-label={t('coupons.search', { defaultValue: 'Search compensation requests' })}
            className="h-9 w-full rounded-xl bg-secondary/60 px-3 text-sm text-foreground ring-1 ring-inset ring-foreground/[0.06] placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-1.5">
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
      </div>

      {/* Sparse content stays a readable column, not a full-bleed sprawl. */}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-5">
        <div className="mx-auto w-full max-w-3xl">
          {requests.isLoading ? (
            <div className="space-y-2.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-2xl" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            // Composed empty state on the card surface — never a bare line
            // floating in the middle of the canvas.
            <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
              <EmptyState
                icon={<TicketIcon size={24} />}
                title={
                  view === 'pending'
                    ? t('coupons.noneWaiting', { defaultValue: 'Nothing waiting on a supervisor.' })
                    : t('coupons.none', { defaultValue: 'No coupon requests here.' })
                }
                description={t('coupons.emptyHintAll', {
                  defaultValue:
                    'Coupon requests raised from tickets — by any agent — land here with their approval status.',
                })}
              />
            </div>
          ) : (
            <ul className="space-y-2.5">
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
                        {[
                          r.contact?.name ?? r.contact?.phone,
                          r.ticket?.subject,
                          r.ticket?.order_id ? `#${r.ticket.order_id}` : null,
                          // Whose ask this is — the queue shows every agent's.
                          r.requested_by?.first_name?.trim() || r.requested_by?.email || null,
                        ]
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
    </div>
  );
}
