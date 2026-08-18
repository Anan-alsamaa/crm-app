import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  EmptyState,
  InboxIcon,
  Input,
  Pill,
  Skeleton,
  SparkleIcon,
  Toolbar,
  cn,
  formatRelative,
  toast,
} from '@yiji/ui';
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
  onDecide: (approve: boolean, note: string, edits?: Record<string, number>) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  /**
   * Amended terms, held until the supervisor approves.
   *
   * A supervisor who thinks the amount is too high had two options and needed a
   * third: reject it, approve it as asked, or approve a smaller one. The third
   * is what actually happens, and it used to mean rejecting and asking the
   * agent to start again.
   */
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [uses, setUses] = useState('');
  const pending = row.status === 'pending';

  const worth = [
    money(row.coupon_value),
    row.coupon_percent != null ? `${row.coupon_percent}%` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        {/* The code as a chip, the worth as the hero numeral — a supervisor
            scans the money first, the code second. */}
        <span className="rounded-md bg-secondary px-2 py-0.5 font-mono text-xs font-semibold text-foreground ring-1 ring-inset ring-foreground/[0.06]">
          {row.coupon_code ?? t('couponApprovals.noCode', { defaultValue: 'no code' })}
        </span>
        {worth && (
          <span className="text-xl font-extrabold leading-none tabular-nums tracking-[-0.03em] text-foreground">
            {worth}
          </span>
        )}
        <Pill tone={TONE[row.status]} size="sm">
          {t(`couponApprovals.status.${row.status}`, { defaultValue: row.status })}
        </Pill>
        <span className="ms-auto text-2xs text-muted-foreground">
          {formatRelative(row.decided_at ?? row.date_created)}
        </span>
      </div>

      {/* Meta pairs flow from the start edge rather than sitting on a rigid
          half-width grid — a short "Asked by" used to strand "Customer" in the
          middle of the card. The ticket line keeps a row to itself because
          subjects run long. */}
      <dl className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-1.5 text-xs">
        <div className="flex items-baseline gap-2">
          <dt className="shrink-0 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('couponApprovals.agent', { defaultValue: 'Asked by' })}
          </dt>
          <dd className="min-w-0 truncate font-medium text-foreground">
            {row.requested_by?.first_name?.trim() || row.requested_by?.email?.trim() || '—'}
          </dd>
        </div>
        <div className="flex min-w-0 items-baseline gap-2">
          <dt className="shrink-0 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('couponApprovals.customer', { defaultValue: 'Customer' })}
          </dt>
          <dd dir="auto" className="min-w-0 truncate font-medium text-foreground">
            {row.contact?.name ?? row.contact?.phone ?? '—'}
          </dd>
        </div>
        <div className="flex w-full min-w-0 items-baseline gap-2">
          <dt className="shrink-0 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
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
        <p className="mt-2.5 rounded-lg bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-foreground ring-1 ring-inset ring-foreground/[0.04]">
          {row.reason}
        </p>
      )}

      {row.status !== 'pending' && row.decision_note && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t('couponApprovals.decidedBy', {
            defaultValue: 'Decided by {{who}}: {{note}}',
            who: row.decided_by?.first_name?.trim() || row.decided_by?.email?.trim() || '—',
            note: row.decision_note,
          })}
        </p>
      )}

      {pending && (
        // The decision strip sits on its own hairline band — the card's footer,
        // so the actions read as one place rather than a loose button cluster.
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
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
              {editing && (
                <div className="mb-1 grid w-full gap-2 rounded-xl bg-secondary/40 p-3 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
                    </span>
                    <Input
                      type="number"
                      min={1}
                      step="1"
                      value={uses}
                      onChange={(e) => setUses(e.target.value)}
                      aria-label={t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
                    />
                  </label>
                  <p className="text-2xs leading-relaxed text-muted-foreground sm:col-span-2">
                    {t('couponApprovals.editHint', {
                      defaultValue:
                        'Approving now grants these instead of what was asked for, and is recorded as an amendment.',
                    })}
                  </p>
                </div>
              )}
              {/* No ticket, nowhere to put the coupon. Approving used to
                  succeed silently and write nothing, so the supervisor believed
                  they had issued money that did not exist. Rejecting stays
                  available — turning something down needs no destination. */}
              <Button
                type="button"
                size="sm"
                disabled={busy || !row.ticket?.id}
                onClick={() => {
                  const edits: Record<string, number> = {};
                  const a = Number(amount);
                  if (amount.trim() !== '' && Number.isFinite(a) && a >= 0) {
                    edits.max_discount = a;
                    // Only the column the category implies, so an amended
                    // percentage can never arrive as an amount.
                    if ((row.discount_category ?? '').toLowerCase() === 'percentage')
                      edits.coupon_percent = a;
                    else edits.coupon_value = a;
                  }
                  const u = Number(uses);
                  if (uses.trim() !== '' && Number.isInteger(u) && u > 0) edits.usage_limit = u;
                  onDecide(true, note, Object.keys(edits).length ? edits : undefined);
                }}
              >
                {t('couponApprovals.approve', { defaultValue: 'Approve' })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setEditing((v) => !v);
                  // Seed from what was asked for, so the supervisor adjusts a
                  // number rather than recalling it.
                  setAmount(String(row.max_discount ?? row.coupon_value ?? ''));
                  setUses(String(row.usage_limit ?? ''));
                }}
              >
                {t('couponApprovals.edit', { defaultValue: 'Edit' })}
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
                {row.ticket?.id
                  ? t('couponApprovals.approveHint', {
                      defaultValue: 'Approving puts the coupon on the ticket.',
                    })
                  : t('couponApprovals.noTicketHint', {
                      defaultValue:
                        'No ticket on this request — there is nowhere to put the coupon.',
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

  const onDecide = (
    row: CouponApprovalRow,
    approve: boolean,
    note: string,
    edits?: Record<string, number>,
  ) => {
    decide.mutate(
      { row, approve, note, supervisorId: user?.id ?? null, edits },
      {
        onSuccess: () =>
          toast.success(
            approve
              ? edits
                ? // Say that the terms changed, so nobody thinks the agent's
                  // numbers went through untouched.
                  t('couponApprovals.approvedEdited', {
                    defaultValue: 'Approved with changes — the amended coupon is on the ticket',
                  })
                : t('couponApprovals.approved', {
                    defaultValue: 'Approved — the coupon is on the ticket',
                  })
              : t('couponApprovals.rejected', { defaultValue: 'Rejected' }),
          ),
        onError: (err) =>
          toast.error(
            // Named, because "could not record that decision" would leave a
            // supervisor retrying a click that can never work.
            err instanceof Error && err.message === 'COUPON_APPROVAL_NO_TICKET'
              ? t('couponApprovals.noTicket', {
                  defaultValue:
                    'This request has no ticket, so there is nowhere to put the coupon. Ask the agent to raise it from the ticket.',
                })
              : t('couponApprovals.decideError', {
                  defaultValue: 'Could not record that decision',
                }),
          ),
      },
    );
  };

  return (
    // The shell's <main> is overflow-hidden by design — every page owns its
    // scroll. This one didn't, so a queue longer than a screen was unreachable,
    // and with no header band the filter pills sat jammed under the navbar.
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('nav.couponApprovals', { defaultValue: 'Coupon approvals' })}
        </h1>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <div className="mx-auto max-w-4xl space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                'pending',
                ...COUPON_APPROVAL_STATUSES.filter((s) => s !== 'pending'),
                'all',
              ] as const
            ).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setView(s)}
                aria-pressed={view === s}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-fast ease-out',
                  view === s
                    ? // The selected filter is a jade wash, the board's pill idiom.
                      'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25'
                    : 'bg-secondary/60 text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`couponApprovals.status.${s}`, { defaultValue: s })}
              </button>
            ))}
          </div>

          {approvals.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full rounded-2xl" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            // Composed, not a bare sentence adrift in a card: a cleared queue is
            // the good ending of this page and should look like one.
            <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
              <EmptyState
                icon={view === 'pending' ? <SparkleIcon size={22} /> : <InboxIcon size={22} />}
                title={
                  view === 'pending'
                    ? t('couponApprovals.clear', {
                        defaultValue: 'Nothing waiting. The queue is clear.',
                      })
                    : t('couponApprovals.none', { defaultValue: 'Nothing here.' })
                }
                description={
                  // Only the good ending gets a second line — it tells the
                  // supervisor where the decided requests went, which is the
                  // question a suddenly empty queue raises.
                  view === 'pending'
                    ? t('couponApprovals.clearHint', {
                        defaultValue: 'Decided requests move to the Approved and Rejected tabs.',
                      })
                    : undefined
                }
              />
            </div>
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  busy={decide.isPending}
                  onDecide={(approve, note, edits) => onDecide(row, approve, note, edits)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
