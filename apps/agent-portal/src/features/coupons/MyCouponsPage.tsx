import { useMemo, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  cn,
  EmptyState,
  toast,
  formatDateTime,
  Pill,
  Skeleton,
  TicketIcon,
  Toolbar,
  ToolbarSpacer,
  SelectMenu,
} from '@yiji/ui';
import {
  COUPON_APPROVAL_STATUSES,
  cleanContactName,
  couponDecision,
  couponOrderId,
  normalizePhone,
  type CouponApprovalStatus,
  type VendorRef,
} from '@yiji/shared-types';
import {
  useMyCouponRequests,
  useUpdatePendingCouponRequest,
  type CouponRequestRow,
} from './api.js';
import { CouponRequestDialog } from './CouponRequestDialog.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import {
  useRecordVendorIds,
  useVendorDirectory,
  VendorBadge,
  type VendorDirectory,
} from '../../lib/vendors.js';
import { correctionOf, useCorrectionStamps, type CorrectionStamp } from './correction-stamps.js';
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
  edited: 'success',
  assigned: 'success',
  rejected: 'destructive',
};

/**
 * Several cards per row (owner, 2026-10-26): three on a 1440 desktop, two on a
 * laptop, one below that. `items-stretch` + `h-full` cards keep a row's
 * footers on one line however long each card's description runs.
 */
const CARD_GRID = 'grid grid-cols-1 items-stretch gap-3 lg:grid-cols-2 min-[1440px]:grid-cols-3';

function sar(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

function amount(r: CouponRequestRow, currency: string): string {
  const bits: string[] = [];
  if (r.coupon_value != null) bits.push(sar(r.coupon_value, currency));
  if (r.coupon_percent != null) bits.push(`${r.coupon_percent}%`);
  return bits.join(' · ');
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
      aria-hidden
    >
      <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3 7.5-7.5z" />
    </svg>
  );
}

/** One coupon term as a compact label-over-value tile. */
function Tile({
  label,
  value,
  className,
}: {
  label: string;
  value: string | number | null | undefined;
  className?: string;
}) {
  const shown = value == null || value === '' ? '—' : String(value);
  return (
    <div
      className={cn(
        'min-w-0 rounded-xl bg-secondary/40 px-3 py-2 ring-1 ring-inset ring-foreground/[0.05]',
        className,
      )}
    >
      <div className="truncate text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </div>
      <div
        dir="auto"
        title={shown}
        className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground"
      >
        {shown}
      </div>
    </div>
  );
}

/**
 * Text the agent may want to copy (owner, 2026-09-29): selectable, so a drag
 * becomes a selection, while a plain click still opens the ticket like the
 * rest of the card. It sits ABOVE the card's overlay, so it forwards the click
 * itself rather than relying on it bubbling there.
 */
function selectable(onOpen: (() => void) | null) {
  return {
    onMouseDown: (e: MouseEvent) => e.stopPropagation(),
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      if (!window.getSelection()?.toString()) onOpen?.();
    },
  };
}

/**
 * ONE REQUEST AS A COMPACT CARD (owner, 2026-10-26: the full-width rows
 * "look stretched").
 *
 * Built like the SLA policy cards the owner pointed at: title and pills at the
 * top, the money as the bold end-aligned numeral, the terms as small tiles,
 * and the card's one action in a hairline footer. EVERY requested term is on
 * the card, so an agent asked "what exactly did you request?" reads it here
 * rather than opening the ticket.
 *
 * The whole card still opens the ticket. The trigger is a STRETCHED OVERLAY
 * under the content rather than a <button> around it, because the card now
 * holds a real Edit button and a button inside a button is invalid HTML. The
 * content passes clicks through to the overlay; the code, the customer line
 * and the Edit button opt back in.
 */
function RequestCard({
  r,
  index,
  vendor,
  vendors,
  canEdit,
  correction,
  onOpen,
  onEdit,
}: {
  r: CouponRequestRow;
  index: number;
  vendor: VendorRef;
  vendors: VendorDirectory;
  canEdit: boolean;
  correction: CorrectionStamp | null;
  onOpen: (() => void) | null;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const customer = [
    /* The PHONE always, not only when the name is absent: it is what an agent
       reads back to a customer. A name that is only that number is dropped
       rather than shown twice in two spellings. */
    cleanContactName(r.contact?.name),
    normalizePhone(r.contact?.phone ?? r.customer_phone ?? '') || null,
  ]
    .filter(Boolean)
    .join(' · ');
  /* The ticket's order FIRST, then the request's own — a late-order coupon has
     no ticket, so reading only `ticket.order_id` showed nothing for them. */
  const order = couponOrderId(r);
  const requester = r.requested_by?.first_name?.trim() || r.requested_by?.email || '—';
  const decider = r.decided_by?.first_name?.trim() || r.decided_by?.email || null;
  const validity =
    r.valid_from || r.valid_to
      ? `${r.valid_from?.slice(0, 10) ?? '…'} → ${r.valid_to?.slice(0, 10) ?? '…'}`
      : null;
  const maxDiscount = r.max_discount != null ? sar(Number(r.max_discount), 'SAR') : null;

  return (
    <li className="h-full">
      <article
        style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
        className="relative flex h-full flex-col rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06] transition-[box-shadow,background-color] duration-fast ease-out hover:bg-primary/[0.02] motion-safe:animate-rise-in"
      >
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={r.ticket?.subject ?? r.coupon_code ?? ''}
            className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
          />
        )}
        <div className="pointer-events-none relative flex min-h-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className="pointer-events-auto select-text font-mono text-sm font-semibold text-foreground"
                  {...selectable(onOpen)}
                >
                  {r.coupon_code ?? t('coupons.noCode', { defaultValue: 'no code' })}
                </span>
                <Pill tone={TONE[r.status] ?? 'success'} size="sm">
                  {t(`coupons.status.${r.status}`, { defaultValue: r.status })}
                </Pill>
                <VendorBadge vendor={vendor} directory={vendors} />
                {r.edited_by_admin && (
                  <Pill tone="primary" size="sm">
                    {t('coupons.amended', { defaultValue: 'Amended' })}
                  </Pill>
                )}
              </div>
              {customer && (
                <p
                  className="pointer-events-auto mt-1 w-fit max-w-full select-text truncate text-xs text-muted-foreground"
                  {...selectable(onOpen)}
                >
                  {customer}
                </p>
              )}
            </div>
            <div className="shrink-0 text-end">
              <div className="text-lg font-extrabold leading-none tabular-nums tracking-[-0.03em] text-foreground">
                {amount(r, 'SAR') || '—'}
              </div>
            </div>
          </div>

          {(r.ticket?.subject || order) && (
            <p
              dir="auto"
              className="pointer-events-auto mt-2.5 w-fit max-w-full select-text truncate text-xs font-medium text-foreground/85"
              {...selectable(onOpen)}
            >
              {[r.ticket?.subject, order ? `#${order}` : null].filter(Boolean).join(' · ')}
            </p>
          )}

          {/* The terms, as asked for. Validity and delivery types run long, so
              each takes two cells rather than truncating to nothing. */}
          <div className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Tile
              label={t('lists.couponType', { defaultValue: 'Coupon type' })}
              value={r.coupon_type}
            />
            <Tile
              label={t('lists.discountCategory', { defaultValue: 'Discount category' })}
              value={r.discount_category}
            />
            <Tile
              label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
              value={maxDiscount}
            />
            <Tile
              className="sm:col-span-2"
              label={t('coupons.validity', { defaultValue: 'Valid' })}
              value={validity}
            />
            <Tile
              label={t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
              value={r.usage_limit}
            />
            <Tile
              className="sm:col-span-2"
              label={t('lists.deliveryType', { defaultValue: 'Delivery types' })}
              value={r.delivery_type}
            />
            <Tile label={t('coupons.itemShort', { defaultValue: 'Item' })} value={r.item_name} />
          </div>

          {r.reason?.trim() && (
            <div className="mt-2.5 rounded-xl bg-secondary/40 px-3 py-2 ring-1 ring-inset ring-foreground/[0.05]">
              <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {t('coupons.descriptionLabel', { defaultValue: 'Description' })}
              </div>
              <p
                dir="auto"
                className="pointer-events-auto mt-0.5 line-clamp-3 select-text whitespace-pre-line text-xs leading-relaxed text-foreground"
                {...selectable(onOpen)}
              >
                {r.reason.trim()}
              </p>
            </div>
          )}

          {/* The supervisor's word. A rejection is what the agent has to tell
              the customer, so it is on the card, in red, not behind a click. */}
          {r.status === 'rejected' ? (
            <p className="mt-2.5 rounded-xl bg-destructive-tint px-3 py-2 text-xs leading-relaxed text-foreground">
              {decider && <span className="font-semibold">{decider}: </span>}
              {r.decision_note ?? t('coupons.noReason', { defaultValue: 'No reason was given.' })}
            </p>
          ) : r.decision_note?.trim() ? (
            <p className="mt-2.5 rounded-xl bg-primary/[0.06] px-3 py-2 text-xs leading-relaxed text-foreground">
              <span className="font-semibold">
                {decider ?? t('coupons.supervisor', { defaultValue: 'Supervisor' })}:{' '}
              </span>
              {r.decision_note.trim()}
            </p>
          ) : null}

          <div className="min-h-2 flex-1" />

          {correction && (
            <p className="mt-2.5 inline-flex min-w-0 items-center gap-1 text-2xs text-primary">
              <PencilIcon />
              <span className="truncate">
                {t('coupons.correctedBy', {
                  defaultValue: 'Corrected by {{who}} · {{when}}',
                  who: requester,
                  when: formatDateTime(correction.at),
                })}
              </span>
            </p>
          )}

          {/* The footer: the card's one action first, then whose request this
              is and when. Edit only on a PENDING request the viewer raised —
              the update filter enforces the same rule server-side. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-foreground/[0.07] pt-3">
            {canEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-primary/10 px-3.5 text-xs font-semibold text-primary transition-colors duration-fast hover:bg-primary/[0.17] active:bg-primary/[0.24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <PencilIcon />
                {t('coupons.correct', { defaultValue: 'Edit' })}
              </button>
            )}
            <span className="ms-auto text-end text-2xs tabular-nums text-muted-foreground">
              {requester} · {formatDateTime(r.date_created)}
            </span>
          </div>
        </div>
      </article>
    </li>
  );
}

export function MyCouponsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const requests = useMyCouponRequests();
  const { user, can } = useAuth();
  /* A reader who raises no coupons of their own (the CEO, owner 2026-10-15)
     opens on every agent and every status; everyone else as before. */
  const reader = !can('request_coupons');
  const [view, setView] = useState<CouponApprovalStatus | 'all'>(() =>
    reader ? 'all' : 'pending',
  );
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
  const [agentId, setAgentId] = useState<string>(() => (reader ? '' : (user?.id ?? '')));
  /** The pending request being corrected, if any. */
  const [editing, setEditing] = useState<CouponRequestRow | null>(null);
  const updateRequest = useUpdatePendingCouponRequest();
  /* Who last corrected a pending request — a mark on the card, never a
     dependency of the list itself. */
  const stamps = useCorrectionStamps();
  /* Which vendor each coupon is for (MV-4) — read, and shown, only when 2+
     vendors are live. A separate read so the queue never names the MV-1
     column itself. */
  const vendors = useVendorDirectory();
  const couponVendors = useRecordVendorIds('coupon_approvals', vendors.show);

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
    /*
     * One box over the facts an agent actually holds when a customer calls:
     * the coupon type/code, the order number, the phone. Name and requester
     * ride along because excluding them would only surprise.
     *
     * BOTH HOMES OF THE ORDER AND THE PHONE, not just the ticket's and the
     * contact's (owner-reported, 2026-09-30: "the phone number/orderid/code
     * based search is not working properly").
     *
     * A LATE-ORDER COUPON HAS NEITHER A TICKET NOR A CONTACT — that is why
     * `order_id` and `customer_phone` are read onto the row at all, as the
     * comment on COUPON_REQUEST_FIELDS says. The search looked only at
     * `ticket.order_id` and `contact.phone`, so for those rows every term was
     * compared against `undefined` and matched nothing: measured against live
     * production, 12 of 32 requests were unfindable by their own order number,
     * and 9 of them by the customer's phone. Searching an order that is plainly
     * on screen and getting an empty list is what was reported.
     *
     * `title` is included because a late-order request carries the customer's
     * number there too, which is what an agent reads off the row.
     */
    return byStatus.filter((r) =>
      [
        r.coupon_type,
        r.coupon_code,
        r.discount_category,
        r.ticket?.order_id,
        r.order_id,
        r.contact?.phone,
        r.customer_phone,
        r.title,
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
      <div className="agent-gutter pb-1 pt-1">
        <div className="rounded-2xl bg-card p-3 shadow-soft ring-1 ring-foreground/[0.06] sm:p-4">
          {/*
          SEARCH AND AGENT ON ONE LINE (owner, 2026-09-29).
          
          The dropdown had a row to itself, which put one short control on a
          full-width line and read as an unfinished layout. The search takes the
          remaining width instead of all of it, so the two sit as a pair.
          
          `min-w-0` on the search: a flex child defaults to its content's
          width, so without it the input refuses to shrink and pushes the
          dropdown off the row on a narrow screen. They stack below `sm`.
        */}
          <div className="mb-3 flex w-full flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder={t('coupons.searchPlaceholder', {
                defaultValue: 'Search by coupon type, code, order ID or customer phone…',
              })}
              aria-label={t('coupons.search', { defaultValue: 'Search compensation requests' })}
              className="h-10 min-w-0 flex-1 rounded-full bg-input px-4 text-sm text-foreground ring-1 ring-inset ring-foreground/[0.14] placeholder:text-muted-foreground hover:ring-foreground/25 focus:outline-none focus:ring-2 focus:ring-primary/50"
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
          <div className="flex w-full flex-wrap gap-1.5">
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
                  'inline-flex h-8 items-center rounded-full px-3.5 text-xs font-semibold transition-colors duration-fast ease-out',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  view === s
                    ? 'bg-ink text-ink-foreground'
                    : 'bg-primary/10 text-primary hover:bg-primary/[0.17]',
                )}
              >
                {t(`coupons.status.${s}`, { defaultValue: s })}
                <span className="ms-1.5 tabular-nums opacity-70">{count(s)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* The list runs the page's full width, like the filter card above it
          (owner, 2026-10-22: these pages "use half the page"). */}
      <div className="agent-gutter min-h-0 flex-1 overflow-auto pb-8 pt-3">
        <div className="w-full">
          {requests.isLoading ? (
            <div className={CARD_GRID}>
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-72 w-full rounded-2xl" />
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
            <ul className={CARD_GRID}>
              {rows.map((r, i) => (
                <RequestCard
                  key={r.id}
                  r={r}
                  index={i}
                  vendor={couponVendors.data?.get(r.id) ?? null}
                  vendors={vendors}
                  /* CORRECT IT, while it is still pending (owner, 2026-09-28).
                     Only the agent who RAISED it — correcting a colleague's
                     wording is not a typo fix. The mutation re-checks the
                     status server-side. */
                  canEdit={r.status === 'pending' && r.requested_by?.id === user?.id}
                  correction={correctionOf(r, stamps.data)}
                  onOpen={r.ticket ? () => navigate(`/tickets/${r.ticket!.id}`) : null}
                  onEdit={() => setEditing(r)}
                />
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
