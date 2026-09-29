import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  cn,
  EmptyState,
  toast,
  formatRelative,
  Pill,
  Skeleton,
  TicketIcon,
  Toolbar,
  ToolbarSpacer,
  SelectMenu,
} from '@yiji/ui';
import {
  COUPON_APPROVAL_STATUSES,
  couponDecision,
  couponOrderId,
  normalizePhone,
  type CouponApprovalStatus,
} from '@yiji/shared-types';
import {
  useMyCouponRequests,
  useUpdatePendingCouponRequest,
  type CouponRequestRow,
} from './api.js';
import { CouponRequestDialog } from './CouponRequestDialog.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
/* Every agent, service accounts excluded — the same list the inbox offers
   for assignment, so the two can never disagree about who exists. */
import { useAgents } from '../inbox/api.js';

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
const TONE: Record<string, 'warning' | 'highlight' | 'success' | 'destructive'> = {
  pending: 'highlight',
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
  /*
   * WHOSE REQUESTS — MINE BY DEFAULT (owner, 2026-09-28).
   *
   * This queue has always shown EVERY agent's requests, which is right for a
   * supervisor and wrong for the agent who just raised one: their own ask was
   * buried among everyone else's, across every status.
   *
   * It defaults to the signed-in agent and can be widened to everyone, rather
   * than being hidden from them — seeing what colleagues have asked for is
   * useful, it just should not be the first thing on the screen.
   */
  const { user } = useAuth();
  /*
   * WHICH AGENT'S REQUESTS (owner, 2026-09-29).
   *
   * A dropdown of EVERY agent with an "All" option, not a mine/everyone
   * toggle: a supervisor needs to look at one colleague, which two buttons
   * cannot express.
   *
   * Defaults to the signed-in user, because the agent who just raised one
   * should not have to find it among everybody else's. `''` is All.
   */
  const agents = useAgents();
  const [agentId, setAgentId] = useState<string>(() => user?.id ?? '');
  /** The pending request being corrected, if any. */
  const [editing, setEditing] = useState<CouponRequestRow | null>(null);
  const updateRequest = useUpdatePendingCouponRequest();

  // "approved" is every APPROVED decision — 'edited' and 'assigned' included.
  // Naming only 'assigned' here left an amended approval in no tab at all.
  const inView = (s: string, v: CouponApprovalStatus | 'all') =>
    v === 'all' || s === v || (v === 'approved' && couponDecision(s) === 'approved');

  const rows = useMemo(() => {
    const all = requests.data ?? [];
    const mine = agentId ? all.filter((r) => r.requested_by?.id === agentId) : all;
    const byStatus = mine.filter((r) => inView(r.status, view));
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
  }, [requests.data, view, search, agentId]);

  /* Counted over the SAME scope as the list: a "3 pending" tab above an empty
     list because the other two belong to somebody else is a bug report. */
  const count = (s: CouponApprovalStatus | 'all') =>
    (requests.data ?? [])
      .filter((r) => !agentId || r.requested_by?.id === agentId)
      .filter((r) => inView(r.status, s)).length;

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
        {/*
          SEARCH AND AGENT ON ONE LINE (owner, 2026-09-29).
          
          The dropdown had a row to itself, which put one short control on a
          full-width line and read as an unfinished layout. The search takes the
          remaining width instead of all of it, so the two sit as a pair.
          
          `min-w-0` on the search: a flex child defaults to its content's
          width, so without it the input refuses to shrink and pushes the
          dropdown off the row on a narrow screen. They stack below `sm`.
        */}
        <div className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder={t('coupons.searchPlaceholder', {
              defaultValue: 'Search by coupon type, code, order ID or customer phone…',
            })}
            aria-label={t('coupons.search', { defaultValue: 'Search compensation requests' })}
            className="h-9 min-w-0 flex-1 rounded-xl bg-secondary/60 px-3 text-sm text-foreground ring-1 ring-inset ring-foreground/[0.06] placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {/* A SELECT, not a row of pills: this lists every agent, and a pill
              per person becomes a wall as the team grows. `SelectMenu` is what
              the rest of the portal uses, so it carries the keyboard and ARIA
              behaviour a bare <select> does not. */}
          <div className="shrink-0">
            <SelectMenu
              value={agentId}
              size="sm"
              onChange={setAgentId}
              aria-label={t('coupons.filterByAgent', { defaultValue: 'Filter by agent' })}
              options={[
                { value: '', label: t('coupons.allAgents', { defaultValue: 'All agents' }) },
                ...(agents.data ?? []).map((a) => ({
                  value: a.id,
                  /* The name people know, falling back to the sign-in address —
                     a staff account has no display name until it is filled in. */
                  label:
                    [a.first_name, a.last_name].filter(Boolean).join(' ').trim() ||
                    (a.email ?? a.id),
                })),
              ]}
            />
          </div>
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
                        {/*
                          SELECTABLE, so the code can be copied with the mouse
                          (owner, 2026-09-29). The card is a <button>, and a
                          button swallows a click-drag as a press gesture rather
                          than a selection — `select-text` plus stopping the
                          MOUSEDOWN is what lets the drag become a selection.
                          No Copy button: the browser's own copy is what was
                          asked for.

                          The CLICK still reaches the card, so opening the
                          ticket keeps working; only a real selection is
                          swallowed, which is what `getSelection` tests for.
                        */}
                        <span
                          className="select-text font-mono text-sm font-semibold text-foreground"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            // A drag that selected something is not a click on
                            // the card; a bare click still opens the ticket.
                            if (window.getSelection()?.toString()) e.stopPropagation();
                          }}
                        >
                          {r.coupon_code ?? t('coupons.noCode', { defaultValue: 'no code' })}
                        </span>
                        <Pill tone={TONE[r.status]} size="sm">
                          {t(`coupons.status.${r.status}`, { defaultValue: r.status })}
                        </Pill>
                      </div>
                      {/* `truncate` removed: it hid the order id and the agent
                          on a narrow rail, which are two of the four things
                          this line exists to show. It wraps instead. */}
                      <div
                        className="mt-1 select-text text-xs leading-relaxed text-muted-foreground"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          if (window.getSelection()?.toString()) e.stopPropagation();
                        }}
                      >
                        {[
                          /* The PHONE always, not only when the name is absent:
                             it is what an agent reads back to a customer. */
                          r.contact?.name,
                          normalizePhone(r.contact?.phone ?? r.customer_phone ?? '') || null,
                          r.ticket?.subject,
                          /* The ticket's order FIRST, then the request's own —
                             a late-order coupon has no ticket, so reading only
                             `ticket.order_id` showed nothing for any of them. */
                          couponOrderId(r) ? `#${couponOrderId(r)}` : null,
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
                    {/*
                      CORRECT IT, while it is still pending (owner, 2026-09-28).
                      
                      A `<span role="button">`, NOT a nested `<button>`: the card
                      itself is a button, and a button inside a button is invalid
                      HTML that browsers resolve by dropping one of them. The
                      click is stopped from reaching the card, or correcting a
                      request would also navigate away from it.
                      
                      Offered only on a PENDING request, and only to the agent
                      who RAISED it — correcting a colleague's wording is not a
                      typo fix. The mutation re-checks both server-side.
                    */}
                    {r.status === 'pending' && r.requested_by?.id === user?.id && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(r);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setEditing(r);
                          }
                        }}
                        className="col-span-full mt-1 inline-flex w-fit cursor-pointer items-center rounded-full bg-secondary px-3 py-1 text-2xs font-medium text-muted-foreground transition-colors duration-fast hover:bg-secondary/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      >
                        {t('coupons.correct', { defaultValue: 'Correct this request' })}
                      </span>
                    )}
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

      {/*
        THE SAME FORM THAT RAISED IT, seeded from the saved values.
        
        Not a second editor: a parallel form would drift from this one's
        validation, and a correction that could save terms the original could
        never have been raised with is not a correction.
        
        Mounted only while editing, so the row's values are read fresh each time
        rather than captured once at page load.
      */}
      {editing && (
        <CouponRequestDialog
          open
          onClose={() => setEditing(null)}
          editingId={editing.id}
          /* The customer and the order are NOT passed as editable: they are what
             the request is about, and changing them would make it a different
             request wearing the same id. */
          contactId={editing.contact?.id ?? null}
          customerPhone={editing.contact?.phone ?? null}
          description={editing.reason ?? null}
          brandId={null}
          restaurantId={null}
          requestedBy={editing.requested_by?.id ?? null}
          initial={{
            title: editing.title ?? '',
            code: editing.coupon_code ?? '',
            issuing_side: editing.issuing_side ?? '',
            delivery_type: editing.delivery_type ?? 'All',
            coupon_type: editing.coupon_type ?? 'Private',
            discount_category: editing.discount_category ?? 'Amount',
            valid_from: editing.valid_from ?? '',
            valid_to: editing.valid_to ?? '',
            coupon_value: editing.coupon_value,
            coupon_percent: editing.coupon_percent,
            max_discount: editing.max_discount ?? 0,
            usage_limit: editing.usage_limit ?? 1,
            compensation_reason: editing.reason ?? '',
            item_name: editing.item_name,
            item_sku: editing.item_sku,
            no_other_discounts: editing.no_other_discounts ?? false,
          }}
          onSave={async (d) => {
            try {
              await updateRequest.mutateAsync({
                id: editing.id,
                patch: {
                  title: d.title,
                  coupon_code: d.code,
                  issuing_side: d.issuing_side,
                  delivery_type: d.delivery_type,
                  coupon_type: d.coupon_type,
                  discount_category: d.discount_category,
                  valid_from: d.valid_from,
                  valid_to: d.valid_to,
                  /* Only ONE of the two money fields is ever set, and which one
                     depends on the category — writing both would leave a second
                     value to disagree with the first. */
                  coupon_value: d.discount_category === 'Percentage' ? null : d.coupon_value,
                  coupon_percent: d.discount_category === 'Percentage' ? d.coupon_percent : null,
                  max_discount: d.max_discount,
                  usage_limit: d.usage_limit,
                  reason: d.compensation_reason,
                  item_name: d.item_name,
                  item_sku: d.item_sku,
                  no_other_discounts: d.no_other_discounts,
                },
              });
              toast.success(t('coupons.corrected', { defaultValue: 'Request updated.' }));
              setEditing(null);
            } catch (err) {
              /* Named, because the one real failure is specific: a supervisor
                 decided it while the form was open. */
              toast.error(
                err instanceof Error
                  ? err.message
                  : t('coupons.correctFailed', { defaultValue: 'Could not update the request.' }),
              );
            }
          }}
        />
      )}
    </div>
  );
}
