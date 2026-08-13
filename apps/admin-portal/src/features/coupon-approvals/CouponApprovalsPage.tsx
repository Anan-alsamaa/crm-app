import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Pill, Skeleton, cn, formatRelative, toast } from '@yiji/ui';
import { COUPON_APPROVAL_STATUSES, type CouponApprovalStatus } from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useCouponApprovals, useDecideCoupon, type CouponApprovalRow } from './api.js';

/**
 * The supervisor's queue: every coupon an agent wants to give away, decided one
 * after another.
 *
 * Built to be worked at speed, because that is what it is for — a supervisor
 * sits here and clears the list. So: opens on pending, one row per request with
 * everything needed to decide already on it, and Approve is a single click. No
 * drawer, no confirmation dialog, no navigating to the ticket and back.
 *
 * REJECTING asks for a reason, and will not proceed without one. An agent told
 * only "no" cannot answer the customer who is still waiting, and "no" with no
 * reason is the fastest way to make a control like this resented.
 */
const TONE: Record<CouponApprovalStatus, 'warning' | 'success' | 'destructive'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'destructive',
};

function money(n: number | null, currency = 'SAR'): string | null {
  if (n == null) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

function Row({
  row,
  onDecide,
  busy,
}: {
  row: CouponApprovalRow;
  onDecide: (approve: boolean, note: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const pending = row.status === 'pending';

  const worth = [
    money(row.coupon_value),
    row.coupon_percent != null ? `${row.coupon_percent}%` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span className="font-mono text-sm font-semibold text-foreground">
          {row.coupon_code ?? t('couponApprovals.noCode', { defaultValue: 'no code' })}
        </span>
        {worth && (
          <span className="text-sm font-semibold tabular-nums text-foreground">{worth}</span>
        )}
        <Pill tone={TONE[row.status]} size="sm">
          {t(`couponApprovals.status.${row.status}`, { defaultValue: row.status })}
        </Pill>
        <span className="ms-auto text-2xs text-muted-foreground">
          {formatRelative(row.decided_at ?? row.date_created)}
        </span>
      </div>

      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">
            {t('couponApprovals.agent', { defaultValue: 'Asked by' })}
          </dt>
          <dd className="min-w-0 truncate font-medium text-foreground">
            {row.requested_by?.first_name ?? row.requested_by?.email ?? '—'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">
            {t('couponApprovals.customer', { defaultValue: 'Customer' })}
          </dt>
          <dd className="min-w-0 truncate font-medium text-foreground">
            {row.contact?.name ?? row.contact?.phone ?? '—'}
          </dd>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <dt className="text-muted-foreground">
            {t('couponApprovals.ticket', { defaultValue: 'Ticket' })}
          </dt>
          <dd className="min-w-0 truncate font-medium text-foreground">
            {row.ticket?.subject ?? '—'}
          </dd>
        </div>
      </dl>

      {row.reason && (
        // The agent's own words about why. A supervisor deciding without this
        // is guessing, and guessing quickly is worse than deciding slowly.
        <p className="mt-2 rounded-lg bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-foreground">
          {row.reason}
        </p>
      )}

      {row.status !== 'pending' && row.decision_note && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t('couponApprovals.decidedBy', {
            defaultValue: 'Decided by {{who}}: {{note}}',
            who: row.decided_by?.first_name ?? row.decided_by?.email ?? '—',
            note: row.decision_note,
          })}
        </p>
      )}

      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {rejecting ? (
            <>
              <Input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('couponApprovals.reasonPlaceholder', {
                  defaultValue: 'Why not? The agent has to tell the customer something.',
                })}
                className="h-9 min-w-[16rem] flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy || !note.trim()}
                onClick={() => onDecide(false, note)}
              >
                {t('couponApprovals.confirmReject', { defaultValue: 'Reject' })}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" disabled={busy} onClick={() => onDecide(true, note)}>
                {t('couponApprovals.approve', { defaultValue: 'Approve' })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                {t('couponApprovals.reject', { defaultValue: 'Reject' })}
              </Button>
              <span className="text-2xs text-muted-foreground">
                {t('couponApprovals.approveHint', {
                  defaultValue: 'Approving puts the coupon on the ticket.',
                })}
              </span>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function CouponApprovalsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [view, setView] = useState<CouponApprovalStatus | 'all'>('pending');
  const approvals = useCouponApprovals(view);
  const decide = useDecideCoupon();

  const rows = approvals.data ?? [];

  const onDecide = (row: CouponApprovalRow, approve: boolean, note: string) => {
    decide.mutate(
      { row, approve, note, supervisorId: user?.id ?? null },
      {
        onSuccess: () =>
          toast.success(
            approve
              ? t('couponApprovals.approved', {
                  defaultValue: 'Approved — the coupon is on the ticket',
                })
              : t('couponApprovals.rejected', { defaultValue: 'Rejected' }),
          ),
        onError: () =>
          toast.error(
            t('couponApprovals.decideError', { defaultValue: 'Could not record that decision' }),
          ),
      },
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap gap-1.5">
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
                : 'bg-card text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`couponApprovals.status.${s}`, { defaultValue: s })}
          </button>
        ))}
      </div>

      {approvals.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl bg-card p-8 text-center text-sm text-muted-foreground shadow-soft">
          {view === 'pending'
            ? t('couponApprovals.clear', { defaultValue: 'Nothing waiting. The queue is clear.' })
            : t('couponApprovals.none', { defaultValue: 'Nothing here.' })}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              busy={decide.isPending}
              onDecide={(approve, note) => onDecide(row, approve, note)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
