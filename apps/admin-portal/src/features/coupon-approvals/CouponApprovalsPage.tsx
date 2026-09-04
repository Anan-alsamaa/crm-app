import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ChevronDownIcon,
  cn,
  DateField,
  EmptyState,
  formatDateTime,
  InboxIcon,
  Input,
  Pill,
  Skeleton,
  SparkleIcon,
  toast,
  Toolbar,
} from '@yiji/ui';
import {
  COUPON_APPROVAL_STATUSES,
  couponTermsProblems,
  isPercentageCategory,
  type CouponApprovalStatus,
  couponDecision,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import {
  useCouponApprovals,
  useDecideCoupon,
  useRetryCouponDelivery,
  useSaveCouponTerms,
  type CouponApprovalRow,
} from './api.js';

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
// Wider than CouponApprovalStatus on purpose: the push worker moves a row to
// `assigned` once Yiji has it, and that state still has to render.
/* Every state in COUPON_APPROVAL_STATUSES, so none falls through to a default
 * that would paint a rejection like an approval. `edited` is an approval on
 * amended terms; `assigned` is an approval Yiji has taken. */
const TONE: Record<string, 'warning' | 'success' | 'destructive'> = {
  pending: 'warning',
  approved: 'success',
  edited: 'success',
  assigned: 'success',
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

/** One labelled input in the amend form. */
function EditField({
  label,
  value,
  onChange,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'number' | 'date';
  hint?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      {/* Dates get the dd/mm/yyyy field rather than the native control, which
          Chrome renders in its own locale regardless of what the page asks
          for. Same ISO value either way, so nothing downstream changes. */}
      {type === 'date' ? (
        <DateField value={value} onChange={onChange} aria-label={label} />
      ) : (
        <Input
          type={type}
          {...(type === 'number' ? { min: 0, step: '0.01' } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
      )}
      {hint && <span className="block text-2xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** One coupon term as label over value, for the terms grid on the card. */
function Term({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  /** For values read aloud character by character — a coupon code. */
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd
        dir="auto"
        className={cn(
          'mt-0.5 truncate text-xs font-medium text-foreground',
          mono && 'font-mono font-semibold',
        )}
      >
        {value ?? '—'}
      </dd>
    </div>
  );
}

/** The full set of terms a supervisor may amend before approving. */
export interface TermEdits {
  title: string;
  issuing_side: string;
  delivery_type: string;
  coupon_type: string;
  discount_category: string;
  valid_from: string;
  valid_to: string;
  amount: string;
  max_discount: string;
  usage_limit: string;
  item_name: string;
  reason: string;
}

function seedEdits(row: CouponApprovalRow): TermEdits {
  const pct = (row.discount_category ?? '').toLowerCase() === 'percentage';
  return {
    title: row.title ?? '',
    issuing_side: row.issuing_side ?? '',
    delivery_type: row.delivery_type ?? '',
    coupon_type: row.coupon_type ?? '',
    discount_category: row.discount_category ?? '',
    valid_from: row.valid_from?.slice(0, 10) ?? '',
    valid_to: row.valid_to?.slice(0, 10) ?? '',
    amount: String((pct ? row.coupon_percent : row.coupon_value) ?? ''),
    max_discount: String(row.max_discount ?? ''),
    usage_limit: String(row.usage_limit ?? ''),
    item_name: row.item_name ?? '',
    reason: row.reason ?? '',
  };
}

/**
 * The amended terms, as a patch of only what actually changed. Empty object =
 * nothing changed, so approving records a straight approval, not an amendment.
 */
function diffEdits(row: CouponApprovalRow, e: TermEdits): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const str = (k: keyof TermEdits, col: string, cur: string | null) => {
    if (e[k].trim() !== (cur ?? '')) out[col] = e[k].trim() || null;
  };
  str('title', 'title', row.title);
  str('issuing_side', 'issuing_side', row.issuing_side);
  str('delivery_type', 'delivery_type', row.delivery_type);
  str('coupon_type', 'coupon_type', row.coupon_type);
  str('discount_category', 'discount_category', row.discount_category);
  str('valid_from', 'valid_from', row.valid_from?.slice(0, 10) ?? null);
  str('valid_to', 'valid_to', row.valid_to?.slice(0, 10) ?? null);
  str('item_name', 'item_name', row.item_name);
  str('reason', 'reason', row.reason);

  // Which money column the amount lands in follows the (possibly amended)
  // category, and the OTHER column is cleared — an amended percentage must
  // never arrive as an amount.
  const category = (out.discount_category as string) ?? row.discount_category ?? '';
  const pct = isPercentageCategory(category);
  const a = Number(e.amount);
  const currentAmount = pct ? row.coupon_percent : row.coupon_value;
  if (
    e.amount.trim() !== '' &&
    Number.isFinite(a) &&
    a > 0 &&
    (a !== (currentAmount ?? null) || 'discount_category' in out)
  ) {
    if (pct) {
      out.coupon_percent = a;
      out.coupon_value = null;
    } else {
      out.coupon_value = a;
      out.coupon_percent = null;
    }
  }
  const cap = Number(e.max_discount);
  if (
    e.max_discount.trim() !== '' &&
    Number.isFinite(cap) &&
    cap >= 0 &&
    cap !== (row.max_discount ?? null)
  ) {
    out.max_discount = cap;
  }
  // For a flat amount the ceiling is the amount. A supervisor who raises the
  // value must not leave the old, lower cap behind it — that is how 568 came to
  // be approved with a 55 cap, and only one of those two numbers could have
  // been what the customer was told.
  if (!pct && typeof out.coupon_value === 'number') {
    out.max_discount = out.coupon_value;
  }
  const u = Number(e.usage_limit);
  if (
    e.usage_limit.trim() !== '' &&
    Number.isInteger(u) &&
    u > 0 &&
    u !== (row.usage_limit ?? null)
  ) {
    out.usage_limit = u;
  }
  return out;
}

function Row({
  row,
  onDecide,
  busy,
}: {
  row: CouponApprovalRow;
  onDecide: (approve: boolean, note: string, edits?: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  /**
   * Deciding a coupon is a money decision, so it is its own privilege rather
   * than something everyone who can SEE the queue inherits. The route already
   * requires it; this is the second lock, so a future change that surfaces the
   * queue read-only somewhere cannot quietly hand out the buttons with it.
   */
  const { can: hasPrivilege } = useAuth();
  const canDecide = hasPrivilege('approve_coupons');
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  /**
   * Amended terms, held until the supervisor approves.
   *
   * A supervisor who thinks the amount is too high had two options and needed a
   * third: reject it, approve it as asked, or approve a smaller one. The third
   * is what actually happens, and it used to mean rejecting and asking the
   * agent to start again. Every term is editable — two lonely number boxes used
   * to be the whole form, which made "fix the dates" a rejection.
   */
  /**
   * Collapsed until asked for.
   *
   * A queue of twenty full-height cards is a page nobody can compare across.
   * Opening one is a click; deciding on one usually is not — the summary line
   * carries enough to say yes.
   */
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Why the terms are being changed. Required before Save will commit. */
  const [editReason, setEditReason] = useState('');
  const [edits, setEdits] = useState<TermEdits>(() => seedEdits(row));
  const setEdit = (k: keyof TermEdits, v: string) => setEdits((e) => ({ ...e, [k]: v }));
  const saveTerms = useSaveCouponTerms();
  const retry = useRetryCouponDelivery();
  const pending = row.status === 'pending';
  /* Delivery only means anything once a decision has been made, and only an
   * APPROVAL is owed to anybody — a rejected coupon was never going to Yiji. */
  // Any approval, including one with amended terms (`edited`) — the worker's
  // push filter includes it, so the retry affordance must too.
  const approvedNotPending = couponDecision(row.status) === 'approved';
  /*
   * NO ORDER, NO COUPON — and a supervisor has to know that BEFORE they decide.
   *
   * Yiji's endpoint is `CreateCouponUserFromOrder`: it attaches a coupon to an
   * order, and resolves the customer from it. Without an order number there is
   * nothing to attach and nobody to attach it to, so the push reports
   * `no-order` and the request sits approved for ever.
   *
   * This is the normal case for a walk-in visitor who scanned the QR code in a
   * branch: they typed a phone number, they may have no Yiji account at all,
   * and nothing in the CRM can look one up — Yiji's API is keyed by customer id
   * and order id, with no lookup by phone. Approving still MEANS something
   * (the decision is recorded, and the compensation can be honoured in the
   * branch), but the customer will not receive it in the app, and telling them
   * otherwise is the failure this warning exists to prevent.
   */
  const canBeDelivered = Boolean(row.ticket?.order_id?.trim());

  /**
   * What is wrong with the numbers as they now stand — the amended terms while
   * editing, the requested ones otherwise. Same rules as the agent's form, from
   * the same function, because both write the same two columns and a rule
   * enforced on one side only is not a rule.
   */
  const termsProblems = useMemo(() => {
    if (!editing) {
      return couponTermsProblems({
        discount_category: row.discount_category,
        coupon_value: row.coupon_value,
        coupon_percent: row.coupon_percent,
        max_discount: row.max_discount,
      });
    }
    const pctNow = isPercentageCategory(edits.discount_category);
    const amount = edits.amount.trim() === '' ? null : Number(edits.amount);
    const cap = edits.max_discount.trim() === '' ? null : Number(edits.max_discount);
    return couponTermsProblems({
      discount_category: edits.discount_category,
      coupon_value: pctNow ? null : amount,
      coupon_percent: pctNow ? amount : null,
      // An amount's ceiling is derived on save, so judge it the same way here
      // rather than warning about a cap the supervisor is not being asked for.
      max_discount: pctNow ? cap : amount,
    });
  }, [editing, edits, row]);

  const worth = [
    money(row.coupon_value),
    row.coupon_percent != null ? `${row.coupon_percent}%` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  /** The branch, as a person would say it. */
  const branch =
    [row.ticket?.store?.brand?.name, row.ticket?.store?.name].filter(Boolean).join(' · ') || null;

  return (
    <li className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
      {/*
        THE SUMMARY LINE, always visible.

        Every request used to render at full height, so a queue of twenty was a
        page of twenty tall cards and comparing two meant scrolling between
        them. This is what a supervisor triages on — what it is, what it costs,
        where it went, who asked and when — with everything else one click away.

        The toggle is a STRETCHED OVERLAY sitting under the content, not a
        <button> wrapped around it. Wrapping was the first attempt and it was
        wrong twice over: only the part of the row it covered responded, so the
        hover lit a fragment of the box rather than the box, and the action
        buttons could not live inside it because a button inside a button is
        invalid. As an overlay the WHOLE row highlights and the whole row
        clicks, while Approve/Edit/Reject sit above it and keep their own
        clicks. Same pattern the order cards in the agent portal use.
      */}
      <div
        className={cn(
          'relative flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl p-4',
          'transition-colors duration-fast ease-out hover:bg-secondary/40',
          expanded && 'rounded-b-none bg-secondary/25',
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={
            row.ticket?.subject ??
            row.title ??
            t('couponApprovals.noTicket', { defaultValue: 'No ticket' })
          }
          className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        />
        {/*
          The summary text sits ABOVE the overlay so it renders, but passes its
          clicks straight through — otherwise the text would be a dead patch in
          the middle of a clickable row.
        */}
        <div className="pointer-events-none relative flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
          <ChevronDownIcon
            size={14}
            className={cn(
              'shrink-0 text-muted-foreground transition-transform duration-fast',
              expanded && 'rotate-180',
            )}
          />
          {/* The ticket is what the request is ABOUT, so it leads. */}
          <span className="min-w-0 max-w-[16rem] truncate text-sm font-semibold text-foreground">
            {row.ticket?.subject ??
              row.title ??
              t('couponApprovals.noTicket', { defaultValue: 'No ticket' })}
          </span>
          {worth && (
            <span className="shrink-0 text-base font-extrabold tabular-nums tracking-[-0.02em] text-foreground">
              {worth}
            </span>
          )}
          <Pill tone={TONE[row.status] ?? 'success'} size="sm">
            {t(`couponApprovals.status.${row.status}`, { defaultValue: row.status })}
          </Pill>
          {row.ticket?.order_id && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              #{row.ticket.order_id}
            </span>
          )}
          {branch && (
            <span className="min-w-0 max-w-[14rem] truncate text-2xs text-muted-foreground">
              {branch}
            </span>
          )}
          <span className="shrink-0 text-2xs text-muted-foreground">
            {row.requested_by?.first_name?.trim() || row.requested_by?.email?.trim() || '—'}
          </span>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {formatDateTime(row.date_created)}
          </span>
        </div>
        {/* Above the overlay AND clickable: deciding must not be a side effect
            of trying to expand, nor the other way round. */}
        {pending && canDecide && !rejecting && !expanded && (
          <div className="relative flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !row.ticket?.id || termsProblems.length > 0}
              title={termsProblems[0]?.message}
              onClick={() => onDecide(true, note)}
            >
              {t('couponApprovals.approve', { defaultValue: 'Approve' })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setExpanded(true);
                setEditing(true);
                setEdits(seedEdits(row));
              }}
            >
              {t('couponApprovals.edit', { defaultValue: 'Edit' })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setExpanded(true);
                setRejecting(true);
              }}
            >
              {t('couponApprovals.reject', { defaultValue: 'Reject' })}
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border/60 px-5 pb-5 pt-4">
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
                {/* Both, when both are known: the name is who it is, the phone is
                what a supervisor searches by and reads back on a call. */}
                {[row.contact?.name, row.contact?.phone].filter(Boolean).join(' · ') || '—'}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="shrink-0 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('couponApprovals.requestedAt', { defaultValue: 'Requested' })}
              </dt>
              {/* Date AND time. "2 hours ago" answers how long they have waited;
              the timestamp is what gets quoted in an audit. */}
              <dd className="min-w-0 truncate font-medium tabular-nums text-foreground">
                {row.date_created ? formatDateTime(row.date_created) : '—'}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-2">
              <dt className="shrink-0 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('couponApprovals.branch', { defaultValue: 'Branch' })}
              </dt>
              <dd dir="auto" className="min-w-0 truncate font-medium text-foreground">
                {/* The readable branch, from the ticket's store. The coupon's own
                restaurant_id is Yiji's identifier — correct to send, useless
                to read. */}
                {[
                  row.ticket?.store?.brand?.name,
                  row.ticket?.store?.code,
                  row.ticket?.store?.name,
                  row.ticket?.store?.city,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </dd>
            </div>
            <div className="flex w-full min-w-0 items-baseline gap-2">
              <dt className="shrink-0 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('couponApprovals.ticket', { defaultValue: 'Ticket' })}
              </dt>
              <dd className="min-w-0 truncate font-medium text-foreground">
                {[
                  row.ticket?.subject,
                  row.ticket?.order_id ? `#${row.ticket.order_id}` : null,
                  row.ticket?.priority,
                  row.ticket?.status,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </dd>
            </div>
          </dl>

          {/* The COMPLETE terms, not the two that fit a summary: a supervisor is
          signing off on all of them, so all of them are on the card. */}
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-secondary/40 p-3 sm:grid-cols-4">
            {/* The CODE leads the detail. It is the one value a customer reads
                back down a phone, and the summary line above deliberately does
                not carry it — a queue is triaged on what a request costs and
                who it is for, not on a string nobody can scan. */}
            <Term
              label={t('coupons.code', { defaultValue: 'Coupon code' })}
              value={row.coupon_code}
              mono
            />
            <Term
              label={t('coupons.titleField', { defaultValue: 'Coupon title' })}
              value={row.title}
            />
            <Term
              label={t('lists.issuingSide', { defaultValue: 'Issuing side' })}
              value={row.issuing_side}
            />
            <Term
              label={t('lists.deliveryType', { defaultValue: 'Delivery types' })}
              value={row.delivery_type}
            />
            <Term
              label={t('lists.couponType', { defaultValue: 'Coupon type' })}
              value={row.coupon_type}
            />
            <Term
              label={t('lists.discountCategory', { defaultValue: 'Discount category' })}
              value={row.discount_category}
            />
            {/* ALWAYS rendered, never hidden when empty.
                It used to be wrapped in `row.item_name && …`, so a coupon with
                no item simply had no Item row — indistinguishable from a page
                that does not carry the field at all, which is how it read as
                missing. `Term` already prints an em dash for an empty value,
                so "no item" now says so out loud. This is also the field the
                supervisor is most likely to be checking the coupon against:
                a coupon raised for one item should be worth that item. */}
            <Term label={t('coupons.itemShort', { defaultValue: 'Item' })} value={row.item_name} />
            {/* A real term of the coupon, so the supervisor approves it rather
                than discovering it. Plain Yes/No, because the column is a
                NEGATIVE — "Yes" here means the customer is restricted. */}
            <Term
              label={t('coupons.noOtherDiscounts', {
                defaultValue: 'Cannot be used with other discounts',
              })}
              value={
                row.no_other_discounts
                  ? t('common.yes', { defaultValue: 'Yes' })
                  : t('common.no', { defaultValue: 'No' })
              }
            />
            <Term
              label={t('couponApprovals.validity', { defaultValue: 'Valid' })}
              value={
                row.valid_from || row.valid_to
                  ? `${row.valid_from?.slice(0, 10) ?? '…'} → ${row.valid_to?.slice(0, 10) ?? '…'}`
                  : null
              }
            />
            <Term
              label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
              value={row.max_discount != null ? money(Number(row.max_discount)) : null}
            />
            <Term
              label={t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
              value={row.usage_limit}
            />
            {(row.brand_id || row.restaurant_id) && (
              <Term
                label={t('couponApprovals.branch', { defaultValue: 'Brand / branch' })}
                value={[row.brand_id, row.restaurant_id].filter(Boolean).join(' · ')}
              />
            )}
          </dl>

          {row.ticket?.description && (
            // What the customer actually reported, straight off the ticket — the
            // supervisor should not have to open the agent portal to read it.
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              <span className="font-semibold uppercase tracking-[0.12em] text-2xs">
                {t('couponApprovals.ticketDescription', { defaultValue: 'Ticket description' })}
              </span>{' '}
              {row.ticket.description}
            </p>
          )}

          {row.reason && (
            // The agent's own words about why. A supervisor deciding without this
            // is guessing, and guessing quickly is worse than deciding slowly.
            <p className="mt-2.5 rounded-lg bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-foreground ring-1 ring-inset ring-foreground/[0.04]">
              {row.reason}
            </p>
          )}

          {/*
            DID IT ACTUALLY REACH THE CUSTOMER?
            The decision and the delivery are different facts, and only one of
            them puts a coupon in someone's app. An approved row that Yiji
            refused looks identical to one the worker has not got to yet, so an
            agent would tell a customer about compensation that does not exist.
            Both states are named here, and the refusal carries Yiji's own words
            plus the only action that un-parks it.
          */}
          {/*
            Shown while it is still PENDING as well as after, because it changes
            what the decision means rather than merely reporting on it.
          */}
          {!canBeDelivered && (
            <p className="mt-2 rounded-lg bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground ring-1 ring-inset ring-warning/25">
              {t('couponApprovals.noOrder', {
                defaultValue:
                  'No order number on this ticket, so Yiji cannot attach a coupon — their coupon is created FROM an order. Approving still records the decision, but the customer will not receive it in the app. Add the order number to the ticket if they have one.',
              })}
            </p>
          )}

          {/* Never-send outranks every other delivery state: there is nothing
              to report on and nothing to retry. */}
          {approvedNotPending && row.delivery_excluded && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t('couponApprovals.deliveryExcluded', {
                defaultValue: 'Not sent to Yiji — {{why}}',
                why:
                  row.delivery_excluded_reason?.trim() ||
                  t('couponApprovals.deliveryExcludedDefault', {
                    defaultValue: 'marked never-send',
                  }),
              })}
            </p>
          )}

          {approvedNotPending &&
            !row.delivery_excluded &&
            canBeDelivered &&
            (row.yiji_coupon_user_id ? (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Pill tone="success" size="sm" dot>
                  {t('couponApprovals.delivered', { defaultValue: 'Delivered to Yiji' })}
                </Pill>
                <span className="tabular-nums">
                  {t('couponApprovals.deliveredRef', {
                    defaultValue: 'reference {{ref}}',
                    ref: row.yiji_coupon_user_id,
                  })}
                </span>
              </p>
            ) : row.yiji_push_error ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground ring-1 ring-inset ring-warning/25">
                <span className="min-w-0 flex-1">
                  {t('couponApprovals.notDelivered', {
                    defaultValue: 'Not delivered — Yiji said: {{why}}',
                    why: row.yiji_push_error,
                  })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(row.id)}
                >
                  {t('couponApprovals.retryDelivery', { defaultValue: 'Try again' })}
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('couponApprovals.deliveryPending', {
                  defaultValue: 'Approved — waiting to be sent to Yiji.',
                })}
              </p>
            ))}

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
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRejecting(false)}
                  >
                    {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
                  </Button>
                </>
              ) : (
                <>
                  {editing && (
                    <div className="mb-1 grid w-full gap-2 rounded-xl bg-secondary/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
                      <EditField
                        label={t('coupons.titleField', { defaultValue: 'Coupon title' })}
                        value={edits.title}
                        onChange={(v) => setEdit('title', v)}
                      />
                      <EditField
                        label={t('lists.issuingSide', { defaultValue: 'Issuing side' })}
                        value={edits.issuing_side}
                        onChange={(v) => setEdit('issuing_side', v)}
                      />
                      <EditField
                        label={t('lists.deliveryType', { defaultValue: 'Delivery types' })}
                        value={edits.delivery_type}
                        onChange={(v) => setEdit('delivery_type', v)}
                        hint={t('couponApprovals.deliveryEditHint', {
                          defaultValue: 'Comma-separated, or "All".',
                        })}
                      />
                      <EditField
                        label={t('lists.couponType', { defaultValue: 'Coupon type' })}
                        value={edits.coupon_type}
                        onChange={(v) => setEdit('coupon_type', v)}
                      />
                      <EditField
                        label={t('lists.discountCategory', { defaultValue: 'Discount category' })}
                        value={edits.discount_category}
                        onChange={(v) => setEdit('discount_category', v)}
                        hint={t('couponApprovals.categoryEditHint', {
                          defaultValue: '"Amount" or "Percentage" — decides what the value means.',
                        })}
                      />
                      <EditField
                        label={
                          edits.discount_category.trim().toLowerCase() === 'percentage'
                            ? t('coupons.couponPercent', { defaultValue: 'Coupon percentage %' })
                            : t('coupons.couponValue', { defaultValue: 'Coupon value (SAR)' })
                        }
                        type="number"
                        value={edits.amount}
                        onChange={(v) => setEdit('amount', v)}
                      />
                      <EditField
                        label={t('performance.from', { defaultValue: 'From' })}
                        type="date"
                        value={edits.valid_from}
                        onChange={(v) => setEdit('valid_from', v)}
                      />
                      <EditField
                        label={t('performance.to', { defaultValue: 'To' })}
                        type="date"
                        value={edits.valid_to}
                        onChange={(v) => setEdit('valid_to', v)}
                      />
                      <EditField
                        label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
                        type="number"
                        value={edits.max_discount}
                        onChange={(v) => setEdit('max_discount', v)}
                      />
                      <EditField
                        label={t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
                        type="number"
                        value={edits.usage_limit}
                        onChange={(v) => setEdit('usage_limit', v)}
                      />
                      <EditField
                        label={t('coupons.itemShort', { defaultValue: 'Item' })}
                        value={edits.item_name}
                        onChange={(v) => setEdit('item_name', v)}
                      />
                      <EditField
                        label={t('coupons.why', { defaultValue: 'Why' })}
                        value={edits.reason}
                        onChange={(v) => setEdit('reason', v)}
                      />
                      {/* WHY the terms were changed, and it is required.
                          
                          Changing what an agent asked for without saying why
                          leaves them looking at a different number with no
                          explanation, and leaves whoever audits it later with
                          a changed record and no account of the change. The
                          reject flow already demands a reason for the same
                          reason. */}
                      <div className="sm:col-span-2 lg:col-span-3">
                        <label
                          htmlFor={`edit-reason-${row.id}`}
                          className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                        >
                          {t('couponApprovals.editReason', {
                            defaultValue: 'Reason for the change',
                          })}
                        </label>
                        <Input
                          id={`edit-reason-${row.id}`}
                          value={editReason}
                          onChange={(e) => setEditReason(e.target.value)}
                          placeholder={t('couponApprovals.editReasonPlaceholder', {
                            defaultValue: 'Why are these terms different from what was asked for?',
                          })}
                          className="mt-1 h-9 w-full"
                        />
                      </div>
                      <p className="text-2xs leading-relaxed text-muted-foreground sm:col-span-2 lg:col-span-3">
                        {t('couponApprovals.editHint', {
                          defaultValue:
                            'Save keeps these terms and leaves the request waiting. Approving now grants them instead of what was asked for, and is recorded as an amendment.',
                        })}
                      </p>
                    </div>
                  )}
                  {/*
                    TWO MODES, never both at once.

                    While an edit is open the only questions are "keep this
                    change" and "throw it away", so Approve and Reject go. They
                    were a genuine hazard sitting there: Approve mid-edit
                    committed a half-finished amendment, and Reject threw the
                    typing away with no warning that it would. Deciding is a
                    different act from editing, and the strip now says which one
                    is in progress.
                  */}
                  {editing ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={
                          busy ||
                          saveTerms.isPending ||
                          termsProblems.length > 0 ||
                          !editReason.trim()
                        }
                        title={
                          termsProblems[0]?.message ??
                          (editReason.trim()
                            ? undefined
                            : t('couponApprovals.editReasonRequired', {
                                defaultValue: 'Give a reason for the change first.',
                              }))
                        }
                        // Turns the colour of Approve under the cursor: this is
                        // the button that commits, and it should say so at the
                        // moment somebody is about to press it. `!` because `cn`
                        // is a joiner, not tailwind-merge — without it the
                        // variant's own hover wins on specificity order.
                        className="hover:!bg-primary hover:!text-primary-foreground"
                        onClick={() => {
                          const patch = diffEdits(row, edits);
                          if (Object.keys(patch).length === 0) {
                            toast.success(
                              t('couponApprovals.nothingChanged', {
                                defaultValue: 'Nothing changed.',
                              }),
                            );
                            return;
                          }
                          saveTerms.mutate(
                            // The reason rides WITH the change, in one write. Two
                            // writes could leave amended terms on record with no
                            // account of why if the second one failed.
                            { id: row.id, edits: { ...patch, decision_note: editReason.trim() } },
                            {
                              onSuccess: () => {
                                toast.success(
                                  t('couponApprovals.termsSaved', {
                                    defaultValue: 'Terms saved. Still waiting on a decision.',
                                  }),
                                );
                                // Saved terms are no longer a draft, so the form
                                // closes and Save goes with it. Leaving an open
                                // editor behind invites a second press that would
                                // find nothing changed.
                                setEditing(false);
                                setEditReason('');
                              },
                              onError: () =>
                                toast.error(
                                  t('couponApprovals.termsSaveFailed', {
                                    defaultValue: 'Could not save those terms.',
                                  }),
                                ),
                            },
                          );
                        }}
                      >
                        {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy || saveTerms.isPending}
                        onClick={() => {
                          // Discard, not just close: re-seeding from the row
                          // means reopening the editor shows what was ASKED
                          // for, never the abandoned draft.
                          setEditing(false);
                          setEditReason('');
                          setEdits(seedEdits(row));
                        }}
                      >
                        {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
                      </Button>
                      <span className="text-2xs text-muted-foreground">
                        {t('couponApprovals.editingHint', {
                          defaultValue: 'Save or cancel this change before deciding.',
                        })}
                      </span>
                    </>
                  ) : (
                    <>
                      {/* No ticket, nowhere to put the coupon. Approving used to
                      succeed silently and write nothing, so the supervisor believed
                      they had issued money that did not exist. Rejecting stays
                      available — turning something down needs no destination. */}
                      {/* A supervisor approving is the last gate before a customer is
                      promised money, so the same rules the agent's form enforces
                      are checked again HERE against the terms as they now stand.
                      Both rows already in the system failed one of them. */}
                      {canDecide && (
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy || !row.ticket?.id || termsProblems.length > 0}
                          title={termsProblems[0]?.message}
                          onClick={() => {
                            // Terms amended earlier in this session are already
                            // saved on the row, so a straight approval is what
                            // this is — nothing is pending to ride along.
                            onDecide(true, note);
                          }}
                        >
                          {t('couponApprovals.approve', { defaultValue: 'Approve' })}
                        </Button>
                      )}
                      {canDecide && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setEditing(true);
                            // Seed from what was asked for, so the supervisor adjusts a
                            // value rather than recalling it.
                            setEdits(seedEdits(row));
                          }}
                        >
                          {t('couponApprovals.edit', { defaultValue: 'Edit' })}
                        </Button>
                      )}
                      {canDecide && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => setRejecting(true)}
                        >
                          {t('couponApprovals.reject', { defaultValue: 'Reject' })}
                        </Button>
                      )}
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
                </>
              )}
            </div>
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

  const all = approvals.data ?? [];
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  /**
   * Filtered in the browser, not the query.
   *
   * The whole queue is already loaded — it is one supervisor's working set, not
   * a table scan — so searching it here answers instantly and keeps the status
   * tabs honest: the counts above never disagree with the list below because
   * both come from the same array.
   *
   * Order id, phone and coupon code are what a supervisor is holding when they
   * come to this page: a customer on the phone, or a code somebody queried.
   */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (from && (r.date_created ?? '') < `${from}T00:00:00`) return false;
      if (to && (r.date_created ?? '') > `${to}T23:59:59`) return false;
      if (!q) return true;
      return [
        r.coupon_code,
        r.ticket?.order_id,
        r.contact?.phone,
        r.contact?.name,
        r.title,
        r.ticket?.store?.name,
        r.ticket?.store?.code,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [all, query, from, to]);

  const onDecide = (
    row: CouponApprovalRow,
    approve: boolean,
    note: string,
    edits?: Record<string, unknown>,
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

          {/* Search and period. Both narrow the list the tabs above produced,
              so a supervisor can hold a status AND a date range at once. */}
          <div className="flex flex-wrap items-end gap-2">
            <Input
              className="h-9 min-w-[16rem] flex-1"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('couponApprovals.search', {
                defaultValue: 'Order ID, phone, or coupon code',
              })}
              placeholder={t('couponApprovals.search', {
                defaultValue: 'Order ID, phone, or coupon code',
              })}
            />
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('complaintDash.from', { defaultValue: 'From' })}
              </span>
              <DateField
                size="md"
                className="w-[9.5rem]"
                value={from}
                onChange={(v) => setFrom(v)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('complaintDash.to', { defaultValue: 'To' })}
              </span>
              <DateField size="md" className="w-[9.5rem]" value={to} onChange={(v) => setTo(v)} />
            </label>
            {(query || from || to) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setQuery('');
                  setFrom('');
                  setTo('');
                }}
              >
                {t('complaintDash.clear', { defaultValue: 'Clear' })}
              </Button>
            )}
            <span className="ms-auto self-center text-xs tabular-nums text-muted-foreground">
              {t('couponApprovals.showing', {
                shown: rows.length,
                total: all.length,
                defaultValue: '{{shown}} of {{total}}',
              })}
            </span>
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
