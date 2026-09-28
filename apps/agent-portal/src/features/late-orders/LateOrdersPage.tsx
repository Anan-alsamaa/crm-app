import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { createItem } from '@directus/sdk';
import {
  Button,
  Card,
  ConfirmDialog,
  DateField,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  PageHeader,
  Pill,
  SelectMenu,
  Skeleton,
  Table,
  Td,
  Th,
  Textarea,
  Tr,
  formatDate,
  toast,
} from '@yiji/ui';
import {
  LATE_ORDER_COMPLAINT_TYPE,
  businessDay,
  businessDayRange,
  matchStore,
  normalizePhone,
  serviceMinutes,
  type LateOrderKind,
  type LateOrderRow,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';
import { useStoreIndex } from '../tickets/useStoreMatch.js';
import { useVendors } from '../tickets/api.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';
import { LateOrderDetail } from './OrderDetail.js';
import {
  resolveLateOrderContact,
  useHandledLateOrders,
  useLateOrders,
  useLateOrderDecisions,
  useRecordLateDecision,
  useServiceTimes,
  useUpdateLateDecision,
  lateOrderTicket,
  FALLBACK_THRESHOLD,
} from './api.js';

/**
 * Late Delivery Handling - the agent's queue.
 *
 * Delivery orders still running past the threshold, with the two decisions the
 * owner specified: Ignore, and Assign coupon. Both demand a reason; both record
 * what was decided so the queue does not offer the same order again a minute
 * later.
 *
 * See docs/LATE-DELIVERY.md for the measured behaviour of the Yiji endpoint
 * behind this - several of its properties are counter-intuitive and load-bearing.
 */

/** How the elapsed time reads: "1h 12m" rather than "72". */
function elapsed(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * How overdue reads at a glance. An order twenty minutes past the line and one
 * three hours past need different urgency from across a room, and these rows
 * are scanned far more often than they are read.
 */
function tone(minutes: number, threshold: number): 'warning' | 'destructive' {
  return minutes >= threshold * 1.5 ? 'destructive' : 'warning';
}

/**
 * How far back the page opens. Thirty days is what operations review, and it
 * is comfortably inside the upstream page budget (two months measured 1,062
 * rows against a 500-per-page walk).
 */
const DEFAULT_WINDOW_DAYS = 30;

/** `YYYY-MM-DD`, n days ago, in the AGENT's own timezone rather than UTC. */
function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

interface DecisionDraft {
  row: LateOrderRow;
  action: 'ignored' | 'compensated';
}

export function LateOrdersPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  /*
   * THE FILTERS (owner, 2026-09-21): order id, then a date range, then brand
   * or branch.
   *
   * `range` is applied on APPLY, not on each keystroke: a range change refetches
   * up to three upstream pages, so typing "2026-09-01" one character at a time
   * would fire a query per character. Order id and brand/branch narrow what is
   * already loaded and so are instant.
   */
  const [orderQuery, setOrderQuery] = useState('');
  const [brandQuery, setBrandQuery] = useState('');
  /*
   * OPENS ON A REAL WINDOW, not on nothing.
   *
   * It used to open on the live queue alone, which is legitimately empty most
   * of the time — nothing is past the threshold right this second — so the
   * page looked broken and read as "no data loaded" (owner, 2026-09-22). It
   * was not: the same request with dates returns 1,062 orders over two months.
   *
   * So it starts on the last 30 days. The live queue is still one click away
   * via "Live only", and the rows say which is which — a finished order is
   * toned neutral and offers no actions.
   */
  const [draftFrom, setDraftFrom] = useState(() => isoDaysAgo(DEFAULT_WINDOW_DAYS));
  const [draftTo, setDraftTo] = useState(() => isoDaysAgo(0));
  const [range, setRange] = useState<{ from: string; to: string } | null>(() => ({
    from: isoDaysAgo(DEFAULT_WINDOW_DAYS),
    to: isoDaysAgo(0),
  }));
  /**
   * TODAY — every late order of the current business day, finished or not.
   *
   * IT USED TO FILTER THE LIVE QUEUE, AND THAT LOST RECORDS (owner,
   * 2026-09-28: "today had 1 record and suddenly became empty... on searching
   * from and to in date range the data is there").
   *
   * The live queue holds only orders still running, which is right for "Live
   * only" — an order that completes has correctly left it. But an order that
   * was an hour late at 14:00 and got delivered at 14:40 is still one of
   * TODAY'S late orders. Filtering the live queue inherited its status
   * restriction, so every row deleted itself the moment the order finished and
   * the day's count drained towards zero as the day went on.
   *
   * So Today now LOADS the business day, which puts the gateway into register
   * mode (`includeCompleted: true`) and keeps completed rows. It is still not
   * the same thing as a history range: it tracks the business day as it rolls
   * over, and it is labelled as today rather than as a window.
   */
  const [todayOnly, setTodayOnly] = useState(false);
  const vendors = useVendors();
  /*
   * The window Today asks for — DERIVED FROM THE CLOCK, never stored.
   *
   * Two calendar dates, because a business day crosses midnight and Yiji's
   * filter only understands dates. Derived rather than written into `range` on
   * click so it ROLLS OVER: at 08:00 the business day changes, this changes
   * with it, and a night shift that leaves the page open is not still looking
   * at yesterday. It cannot key off the queue's own `builtAt` — that is the
   * answer to this query, so reading it here would be circular.
   */
  const [dayTick, setDayTick] = useState(() => businessDay(new Date().toISOString()));
  useEffect(() => {
    /* One cheap check a minute, so 08:00 rolls the view over on its own. A
       minute is plenty for an hour-scale boundary and costs nothing; the state
       only changes on the one tick a day where the answer differs, so this is
       not a re-render every minute. */
    const id = setInterval(() => {
      const day = businessDay(new Date().toISOString());
      setDayTick((prev) => (prev === day ? prev : day));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  const todayRange = useMemo(() => (dayTick ? businessDayRange(dayTick) : null), [dayTick]);

  /* The queue follows the range. Today is a range too — so finished orders
     stay on the list — but it is still live, so it keeps polling. */
  const queue = useLateOrders(
    todayOnly ? (todayRange ?? undefined) : (range ?? undefined),
    true,
    todayOnly,
  );
  const handled = useHandledLateOrders();
  const record = useRecordLateDecision();

  /** The classification per row, defaulted to late delivery. */
  const [kinds, setKinds] = useState<Record<string, LateOrderKind>>({});
  const [draft, setDraft] = useState<DecisionDraft | null>(null);
  const [reason, setReason] = useState('');
  /** What the agent DID about it — the second field, and editable later. */
  const [actionTaken, setActionTaken] = useState('');
  /** The decision being EDITED via Comments, when the row already has one. */
  const [editingDecisionId, setEditingDecisionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The row whose cart + tracking is open. One at a time: the panel is tall,
      and two open rows push the queue itself off the screen. */
  const [expanded, setExpanded] = useState<string | null>(null);

  /**
   * The coupon form's subject, held while it is open.
   *
   * Carries `kind` and `ticketId` because the DECISION is written when the
   * request is created, not before — so everything it needs has to survive the
   * form being open.
   */
  const [coupon, setCoupon] = useState<{
    row: LateOrderRow;
    reason: string;
    /** Carried through the coupon form so the decision records it too. */
    actionTaken: string;
    kind: LateOrderKind;
    ticketId: string | null;
    /* Resolved before the form opens, so the request names the customer it is
       for rather than an anonymous row. */
    contactId: string | null;
  } | null>(null);

  const threshold = queue.data?.thresholdMinutes ?? FALLBACK_THRESHOLD;
  // Local, not UTC: the date pickers are the agent's own calendar.
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
  /*
   * The business day we are CURRENTLY IN — what the Today button means.
   *
   * Recomputed from the queue's own build time rather than held in state, so
   * it rolls over at 08:00 while the page is open instead of pinning whatever
   * day it was mounted on. A night shift does not reload the page at 08:00 to
   * get the right answer.
   */
  /* The same tick the range is derived from, so the pill, the per-row filter
     and the window actually requested can never disagree — reading `builtAt`
     here once meant the filter could name a different day than the query. */
  const currentBusinessDay = dayTick;
  const soleVendorId = vendors.data?.length === 1 ? vendors.data[0]!.id : null;
  /* The store master, for attributing a raised ticket to its branch. Shares
     the tickets page's query key, so it is one cached copy. */
  const { index: storeIndex } = useStoreIndex();

  /*
   * The ORDER'S LINES, for the coupon form's Item field.
   *
   * The ticket path passes these; this one never did, so the Item dropdown on
   * a late-order coupon was always empty and the coupon could not name what it
   * was compensating (owner, 2026-09-28).
   *
   * Same query key as the Cart & tracking panel, so opening the coupon form on
   * a row whose cart has already been looked at costs nothing at all.
   */
  const couponCart = useQuery({
    queryKey: ['order-cart', coupon?.row.orderId],
    enabled: !!coupon?.row.orderId,
    queryFn: () => commerce.getOrderCart(coupon!.row.orderId),
    staleTime: 5 * 60_000,
    retry: false,
  });

  /*
   * What is still OPEN.
   *
   * Yiji has no idea we have handled anything, so a decided order keeps coming
   * back from `GetFilteredOrders` until it completes. Filtering here - rather
   * than trusting the upstream list - is what stops an agent facing the same
   * three rows every thirty seconds.
   */
  const rows = useMemo(() => {
    const done = handled.data ?? new Set<string>();
    const order = orderQuery.trim();
    const brand = brandQuery.trim().toLowerCase();
    return (queue.data?.rows ?? []).filter((r) => {
      /*
       * A handled order is hidden from the LIVE queue only.
       *
       * In a historical window the decision is part of what you are looking
       * at — hiding those rows would quietly under-report the month.
       */
      if (!range && !todayOnly && done.has(r.orderId)) return false;
      /*
       * TODAY means TODAY'S BUSINESS DAY, not the calendar date.
       *
       * Trading runs 08:00 to 04:00 the next morning, so a calendar cut splits
       * one night's work in two: an order at 01:00 is still tonight's trading
       * and was being EXCLUDED, while one at 06:00 belongs to the night that
       * just ended and was being INCLUDED. Both wrong, and both invisible
       * unless you were working at those hours (owner, 2026-09-28).
       *
       * `businessDay` applies Riyadh's offset itself — the boundary is a
       * wall-clock hour in the branch's own day, never the browser's.
       */
      if (todayOnly && businessDay(r.placedAt) !== currentBusinessDay) return false;
      if (order && !r.orderId.includes(order)) return false;
      if (brand && !`${r.brandName ?? ''} ${r.restaurantName ?? ''}`.toLowerCase().includes(brand))
        return false;
      return true;
    });
  }, [queue.data, handled.data, orderQuery, brandQuery, range, todayOnly, currentBusinessDay]);

  /*
   * SERVICE TIME for the rows actually on screen.
   *
   * Driver-accept is not in the late-orders list; it is one status-history call
   * per order. Asking for the whole queue would be hundreds of calls into
   * Yiji's production API per page load, so this asks only for what is
   * rendered. `nowMs` ticks with the queue's own refresh so a live order's
   * service time advances with everything else rather than freezing at mount.
   */
  const serviceTimes = useServiceTimes(rows.map((r) => r.orderId));
  /* What has already been decided, so Comments opens populated. */
  const decisions = useLateOrderDecisions();
  const updateDecision = useUpdateLateDecision();
  const nowMs = queue.dataUpdatedAt || Date.now();

  const kindOf = (row: LateOrderRow): LateOrderKind => kinds[row.orderId] ?? 'late_delivery';

  const openDecision = (row: LateOrderRow, action: 'ignored' | 'compensated') => {
    /*
     * Seeded from the decision already recorded, when there is one.
     *
     * The Comments button reopens this same box on a row that has been
     * decided, so it must show what was written rather than a blank form an
     * agent would have to retype.
     */
    const existing = decisions.data?.get(row.orderId);
    setDraft({ row, action });
    setReason(existing?.reason ?? '');
    setActionTaken(existing?.action_taken ?? '');
    setEditingDecisionId(existing?.id ?? null);
  };

  /**
   * Commit the decision.
   *
   * ORDER MATTERS, and it differs by action.
   *
   * **Ignore** records immediately: the decision IS the whole act.
   *
   * **Assign coupon** records NOTHING yet — it opens the coupon form and the
   * decision is written only once a request actually exists. Recording first
   * looked safer (the order leaves the queue, so two agents cannot both work
   * it) and was wrong: an agent who opens the form and closes it leaves a
   * permanent row claiming the customer was compensated when nothing was ever
   * sent. Staging produced exactly that row within minutes of the feature
   * going up. A ticket-less order sitting in the queue is a visible, fixable
   * state; a false "compensated" is a quiet lie in the register operations
   * read. See [[silent-empty-failures]] for this shape.
   *
   * For a late PREPARATION the owner asked for a ticket as well, prefilled
   * from the order. It is raised FIRST and its id recorded with the decision,
   * so a failure leaves nothing half-done.
   */
  const commit = async () => {
    if (!draft) return;
    const text = reason.trim();
    if (!text) return;
    const kind = kindOf(draft.row);
    setBusy(true);
    try {
      let ticketId: string | null = null;
      /* The CONTACT, per the owner's spec. Without it the branch gets a
         complaint with nobody attached, the ticket cannot be found by
         searching the number that raised it, and the coupon request names
         nobody. Resolved ONCE here and reused by both paths. */
      const contactId = await resolveLateOrderContact(draft.row, soleVendorId);
      if (kind === 'late_preparation') {
        const created = (await directus.request(
          createItem(
            'tickets' as never,
            lateOrderTicket({
              row: draft.row,
              kind,
              reason: text,
              contactId,
              vendorId: soleVendorId,
              agentId: user?.id ?? null,
              /* The branch, resolved from the store master. Without it the
                 ticket has no `restaurantName` and the operations report —
                 which shows COMPLETE rows only — hides it silently. */
              storeMatch: matchStore(storeIndex, {
                restaurantId: draft.row.restaurantId,
                restaurantName: draft.row.restaurantName,
                brandName: draft.row.brandName,
              }),
            }) as never,
          ),
        )) as { id: string };
        ticketId = created?.id ?? null;
      }
      if (draft.action === 'compensated') {
        // Nothing is recorded yet — see the note above. The coupon form writes
        // the decision itself, once a request actually exists.
        setCoupon({
          row: draft.row,
          reason: text,
          actionTaken,
          kind,
          ticketId,
          contactId,
        });
      } else if (editingDecisionId) {
        /* Editing an existing decision: only the wording changes. The decision
           TYPE stays as it was taken — fixing a typo must not turn an ignore
           into a compensation. */
        await updateDecision.mutateAsync({
          id: editingDecisionId,
          reason: text,
          actionTaken,
        });
        toast.success(t('lateOrders.commentsSaved', { defaultValue: 'Saved.' }));
      } else {
        await record.mutateAsync({
          row: draft.row,
          kind,
          action: 'ignored',
          reason: text,
          actionTaken,
          agentId: user?.id ?? null,
          ticketId,
        });
        toast.success(
          t('lateOrders.ignored', { defaultValue: 'Ignored, and the reason recorded.' }),
        );
      }
      setDraft(null);
      setReason('');
      setActionTaken('');
      setEditingDecisionId(null);
    } catch {
      toast.error(
        t('lateOrders.decisionFailed', { defaultValue: 'Could not record that decision.' }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    /* Every page in this portal supplies its OWN padding — the shell gives
       none — and this one had none, so its text sat flush against the left
       edge of the window (owner, 2026-09-22). `p-4` matches the inbox and
       contacts; `min-h-0` keeps the table's own scroll working. */
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title={t('lateOrders.title', { defaultValue: 'Late orders' })}
        subtitle={t('lateOrders.subtitle', {
          minutes: threshold,
          defaultValue: 'Delivery orders running longer than {{minutes}} minutes.',
        })}
      />

      {/*
        Order id, then dates, then brand/branch — the owner's order (2026-09-21),
        which is also the order an agent narrows in: they usually have a number.
      */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.order', { defaultValue: 'Order number' })}
          </span>
          <Input
            value={orderQuery}
            onChange={(e) => setOrderQuery(e.target.value)}
            placeholder={t('lateOrders.filter.orderPlaceholder', { defaultValue: 'e.g. 1314302' })}
            inputMode="numeric"
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.from', { defaultValue: 'From' })}
          </span>
          {/* `DateField`, not `<Input type="date">`: a native date input renders
              in the BROWSER's locale, so an en-US machine showed mm/dd/yyyy on a
              page every other date in this app writes as dd/mm/yyyy. DateField
              takes and emits the same ISO `yyyy-mm-dd` string, so the state, the
              `max` bound and the query are unchanged. */}
          <DateField
            value={draftFrom}
            max={today}
            onChange={(v) => setDraftFrom(v)}
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.to', { defaultValue: 'To' })}
          </span>
          <DateField value={draftTo} max={today} onChange={(v) => setDraftTo(v)} className="w-40" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.brand', { defaultValue: 'Brand or branch' })}
          </span>
          <Input
            value={brandQuery}
            onChange={(e) => setBrandQuery(e.target.value)}
            placeholder={t('lateOrders.filter.brandPlaceholder', {
              defaultValue: 'e.g. Okashi, Narjis',
            })}
            className="w-52"
          />
        </label>
        {/* Applied on click, not per keystroke: a range walks up to three
            upstream pages, so typing a date would fire a query per character. */}
        <Button
          variant="secondary"
          disabled={!draftFrom || !draftTo || draftFrom > draftTo}
          onClick={() => {
            setTodayOnly(false);
            setRange({ from: draftFrom, to: draftTo });
          }}
        >
          {t('lateOrders.filter.apply', { defaultValue: 'Load range' })}
        </Button>
        {/*
          TODAY — the whole business day, finished orders included.

          It LOADS the business day's calendar span rather than filtering the
          live queue: the live queue drops an order the moment it completes, so
          filtering it made today's rows vanish one by one (owner, 2026-09-28).
          The span is two calendar dates because trading crosses midnight; each
          row is then narrowed to the exact business day below.
        */}
        <Button
          variant={todayOnly ? 'brand' : 'ghost'}
          aria-pressed={todayOnly}
          onClick={() => {
            const next = !todayOnly;
            setTodayOnly(next);
            /* The range is DERIVED from the business day, not stored — see
               `todayRange`. Clearing the stored one is all that is needed. */
            setRange(null);
          }}
        >
          {t('lateOrders.filter.today', { defaultValue: 'Today' })}
        </Button>
        {/* Always offered, because the page no longer STARTS live — this is how
            an agent gets to "what is late right now". */}
        <Button
          variant="ghost"
          onClick={() => {
            setRange(null);
            setOrderQuery('');
            setBrandQuery('');
            setTodayOnly(false);
          }}
        >
          {t('lateOrders.filter.clear', { defaultValue: 'Live only' })}
        </Button>
        {/* Says which view is on, so "Today" and "Live only" are never
            ambiguous — an empty live queue is good news, not a broken page. */}
        {todayOnly && (
          <Pill tone="success" size="sm">
            {/* Names the business day, because "today" is not the calendar
                date here: trading runs 08:00 to 04:00, so at 01:00 the answer
                is still yesterday's date and an agent has to be able to see
                which day they are looking at.

                It says EVERY, not "still running": the whole point of the fix
                is that a delivered order stays on today's list. */}
            {t('lateOrders.filter.todayNote', {
              day: currentBusinessDay ? formatDate(currentBusinessDay) : '',
              defaultValue: 'Business day {{day}} — every late order, finished or running',
            })}
          </Pill>
        )}
        {/* A historical window is NOT the live queue, and must never be mistaken
            for it — the rows are finished orders. Today loads a range too, and
            labels itself above, so this only speaks for a chosen window. */}
        {range && !todayOnly && (
          <Pill tone="blue" size="sm">
            {t('lateOrders.filter.historyNote', {
              // dd/mm/yyyy, like every other date on screen — the pill used to
              // print the raw ISO the query carries.
              from: formatDate(range.from),
              to: formatDate(range.to),
              defaultValue: 'History {{from}} to {{to}} — finished orders included',
            })}
          </Pill>
        )}
      </div>

      {queue.isError ? (
        /*
         * A failed fetch must NOT look like an empty queue.
         *
         * "Nothing is late" and "we cannot see what is late" are opposite
         * facts, and the second is the one an agent has to act on.
         */
        <ErrorState
          title={t('lateOrders.errorTitle', { defaultValue: 'Could not load late orders' })}
          message={t('lateOrders.errorBody', {
            defaultValue:
              'The order system did not answer. That is not the same as there being none - try again in a moment.',
          })}
          onRetry={() => void queue.refetch()}
        />
      ) : queue.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('lateOrders.noneTitle', { defaultValue: 'Nothing is running late' })}
          description={t('lateOrders.noneBody', {
            minutes: threshold,
            defaultValue: 'No delivery order has passed {{minutes}} minutes. This updates itself.',
          })}
        />
      ) : (
        <Card className="min-h-0 flex-1 overflow-auto p-0">
          <Table>
            <thead>
              <Tr>
                <Th>{t('lateOrders.col.order', { defaultValue: 'Order' })}</Th>
                {/*
                  "Running" said nothing (owner, 2026-09-28) — running for how
                  long, measured from what? This is the WHOLE age of the order,
                  from the moment it was placed, and it is the number the
                  threshold is applied to. Named for what it measures, and the
                  sub-label says from when, so it cannot be confused with the
                  driver leg beside it.
                */}
                <Th>
                  {t('lateOrders.col.elapsed', { defaultValue: 'Total time' })}
                  <span className="block text-[10px] font-normal normal-case text-muted-foreground">
                    {t('lateOrders.col.elapsedHint', { defaultValue: 'since order placed' })}
                  </span>
                </Th>
                <Th>
                  {t('lateOrders.col.service', { defaultValue: 'Service time' })}
                  <span className="block text-[10px] font-normal normal-case text-muted-foreground">
                    {t('lateOrders.col.serviceHint', { defaultValue: 'since driver accepted' })}
                  </span>
                </Th>
                <Th>{t('lateOrders.col.brand', { defaultValue: 'Brand / branch' })}</Th>
                <Th>{t('lateOrders.col.customer', { defaultValue: 'Customer' })}</Th>
                <Th>{t('lateOrders.col.status', { defaultValue: 'Status' })}</Th>
                <Th>{t('lateOrders.col.kind', { defaultValue: 'Source of delay' })}</Th>
                {/*
                  THE ACTIONS, SPLIT INTO THREE (owner, 2026-09-28).

                  Four controls sat in one "Decision" cell and read as a wall of
                  buttons — the decision itself, the thing you look at first,
                  and the notes all competing at the same weight. Now: what you
                  LOOK AT, what you DECIDE, and the note. Each column is titled,
                  so the buttons no longer have to carry the grouping on their
                  own.
                */}
                <Th>{t('lateOrders.col.detail', { defaultValue: 'Order' })}</Th>
                <Th>{t('lateOrders.col.actions', { defaultValue: 'Decision' })}</Th>
                <Th>{t('lateOrders.col.notes', { defaultValue: 'Notes' })}</Th>
              </Tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.orderId}>
                  <Tr>
                    <Td className="whitespace-nowrap font-medium tabular-nums">{row.orderId}</Td>
                    <Td className="whitespace-nowrap">
                      <Pill tone={tone(row.minutesElapsed, threshold)} size="sm">
                        {elapsed(row.minutesElapsed)}
                      </Pill>
                    </Td>
                    {/*
                      SERVICE TIME — the DRIVER leg, not the whole order.
                      Closed: close − driver-accept. Live: now − driver-accept.
                      Blank while the batch is still loading, and "-" once we
                      know the driver has not accepted: an empty cell and a
                      confirmed "no driver yet" are different facts.
                    */}
                    <Td className="whitespace-nowrap tabular-nums">
                      {(() => {
                        if (serviceTimes.isLoading)
                          return (
                            /* A skeleton, not a spinner: one spinner per row
                               reads as a page that is broken, and the width is
                               known so nothing reflows when the value lands. */
                            <span className="inline-block h-4 w-12 animate-pulse rounded bg-muted/60 align-middle" />
                          );
                        const mins = serviceMinutes(
                          serviceTimes.data?.[row.orderId] ?? null,
                          row.closedAt ?? null,
                          nowMs,
                        );
                        if (mins === null)
                          return <span className="text-muted-foreground/60">&mdash;</span>;
                        /*
                         * A LIVE COUNT LOOKS LIVE; A FINISHED ONE LOOKS FINAL
                         * (owner, 2026-09-28).
                         *
                         * The same "1h 12m" meant two different things — still
                         * climbing, or settled — and nothing on screen said
                         * which. A closed order carries `closedAt`, so the
                         * difference is known per row, not guessed.
                         *
                         * The live one gets a soft pulsing dot and the brand
                         * colour; the closed one is plain and muted. CSS only —
                         * no timer, no per-row state. The number itself
                         * advances with the queue's own 30s refresh, which is
                         * the resolution the data actually has: a per-second
                         * ticker would re-render every row for a figure that
                         * cannot change more often than its source.
                         */
                        const live = !row.closedAt;
                        return live ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-brand">
                            <span
                              className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand"
                              aria-hidden="true"
                            />
                            {elapsed(mins)}
                            <span className="sr-only">
                              {t('lateOrders.serviceLive', { defaultValue: 'still counting' })}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{elapsed(mins)}</span>
                        );
                      })()}
                    </Td>
                    <Td className="max-w-[16rem] truncate">
                      {[row.brandName, row.restaurantName].filter(Boolean).join(' - ') || '-'}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {row.customerName || row.customerPhone || '-'}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {t(`commerce.orderStatuses.${row.status}`, { defaultValue: row.status })}
                    </Td>
                    <Td>
                      {/*
                        `SelectMenu`, not a native `<select>`: the OS styles the
                        native menu itself, so it arrived as a boxed grey
                        control that matched nothing else on the page (owner,
                        2026-09-22). This is the same listbox the rest of the
                        portal uses — keyboard, type-ahead and ARIA included —
                        and it renders in a portal so it is never clipped by the
                        table's own scroll.

                        The dots carry the meaning at a glance: amber for a
                        kitchen that ran long, blue for a delivery that did.
                      */}
                      <SelectMenu
                        value={kindOf(row)}
                        size="sm"
                        aria-label={t('lateOrders.col.kind', {
                          defaultValue: 'Source of delay',
                        })}
                        onChange={(v) =>
                          setKinds((cur) => ({ ...cur, [row.orderId]: v as LateOrderKind }))
                        }
                        options={[
                          {
                            value: 'late_delivery',
                            label: t('lateOrders.kind.late_delivery', {
                              defaultValue: 'Late delivery',
                            }),
                            dot: 'oklch(var(--sky))',
                          },
                          {
                            value: 'late_preparation',
                            label: t('lateOrders.kind.late_preparation', {
                              defaultValue: 'Late preparation',
                            }),
                            dot: 'oklch(var(--warning))',
                          },
                        ]}
                      />
                    </Td>
                    {/*
                      COLUMN 1 — WHAT YOU LOOK AT. Always offered, decided or
                      not: reviewing what was ordered is exactly why somebody
                      opens a handled row.
                    */}
                    <Td>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-haspopup="dialog"
                        onClick={() => setExpanded(row.orderId)}
                      >
                        {t('lateOrders.showDetail', { defaultValue: 'Cart & tracking' })}
                      </Button>
                    </Td>
                    {/* COLUMN 2 — WHAT YOU DECIDE. */}
                    <Td>
                      {/*
                        A HANDLED historical order shows its decision instead of
                        the buttons: offering "Ignore" on something already
                        ignored invites a second, contradictory record.
                      */}
                      {range && handled.data?.has(row.orderId) ? (
                        <Pill tone="success" size="sm">
                          {t('lateOrders.alreadyHandled', { defaultValue: 'Handled' })}
                        </Pill>
                      ) : (
                        /* The two outcomes, and only those. `whitespace-nowrap`
                           so the pair never wraps into a two-line cell on a
                           narrow screen. */
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <Button size="sm" onClick={() => openDecision(row, 'compensated')}>
                            {t('lateOrders.assignCoupon', { defaultValue: 'Assign coupon' })}
                          </Button>
                          {/* `secondary`, not `ghost`: Ignore is a recorded
                              decision, not a dismissal, and a transparent
                              control read as a link next to a filled one. */}
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => openDecision(row, 'ignored')}
                          >
                            {t('lateOrders.ignore', { defaultValue: 'Ignore' })}
                          </Button>
                        </div>
                      )}
                    </Td>
                    {/*
                      COLUMN 3 — THE NOTE. On EVERY row, handled or not (owner,
                      2026-09-27). Opens the same box; on a row already decided
                      it arrives populated and saves as an edit, so the reason
                      and the action can be corrected without re-deciding
                      anything.
                    */}
                    <Td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openDecision(row, 'ignored')}
                      >
                        {t('lateOrders.comments', { defaultValue: 'Comments' })}
                      </Button>
                    </Td>
                  </Tr>
                </Fragment>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/*
        CART & TRACKING IN A CENTRED DIALOG.

        First it was a full-width row inside the table, which pushed every other
        late order off the screen — on a queue whose whole point is scanning
        rows, the detail displaced the thing being scanned (owner, 2026-09-27).
        Then a side drawer, which fixed that but put the thing you opened to
        READ in the corner of the eye (owner, 2026-09-28). Centred is the honest
        shape for it: nothing else competes while it is open, and Esc or the
        backdrop returns to the queue exactly where it was.

        Mounted only while open, so the queue never pays for carts nobody asked
        to see — the same reason the inline version was conditional.
      */}
      <Modal
        open={!!expanded}
        onClose={() => setExpanded(null)}
        size="lg"
        title={t('lateOrders.detailTitle', {
          order: expanded ?? '',
          defaultValue: 'Order {{order}} — cart & tracking',
        })}
      >
        {expanded && <LateOrderDetail orderId={expanded} vendorId={soleVendorId} />}
      </Modal>

      {/*
        The reason, demanded for BOTH actions.

        `ConfirmDialog` rather than a hand-rolled overlay: it brings the focus
        trap, Escape and backdrop-click that a bare `fixed inset-0` div does
        not, and every other confirm in these portals already looks like this.
        The textarea rides in `description`, which takes a ReactNode.
      */}
      {draft && (
        <ConfirmDialog
          open
          title={
            editingDecisionId
              ? t('lateOrders.commentsTitle', { defaultValue: 'Comments' })
              : draft.action === 'ignored'
                ? t('lateOrders.ignoreTitle', { defaultValue: 'Ignore this order?' })
                : t('lateOrders.couponTitle', { defaultValue: 'Compensate this order' })
          }
          description={
            <div className="space-y-3">
              <p>
                {t('lateOrders.reasonPrompt', {
                  order: draft.row.orderId,
                  minutes: elapsed(draft.row.minutesElapsed),
                  defaultValue: 'Order {{order}} has been running {{minutes}}. Why?',
                })}
              </p>
              {/* TWO fields, labelled: why it happened, and what was done
                  about it. They answer different questions and were one box
                  (owner, 2026-09-27). */}
              <label className="block space-y-1">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('lateOrders.reasonLabel', { defaultValue: 'Reason' })}
                </span>
                <Textarea
                  autoFocus
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('lateOrders.reasonPlaceholder', {
                    defaultValue: 'The reason - recorded against this order.',
                  })}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('lateOrders.actionLabel', { defaultValue: 'Action taken' })}
                </span>
                <Textarea
                  rows={2}
                  value={actionTaken}
                  onChange={(e) => setActionTaken(e.target.value)}
                  placeholder={t('lateOrders.actionPlaceholder', {
                    defaultValue: 'What you did about it - e.g. called the branch.',
                  })}
                />
              </label>
              {kindOf(draft.row) === 'late_preparation' && (
                <p className="rounded-lg bg-secondary/50 px-3 py-2 text-xs leading-relaxed">
                  {t('lateOrders.willRaiseTicket', {
                    type: LATE_ORDER_COMPLAINT_TYPE.late_preparation,
                    defaultValue: 'A "{{type}}" ticket will be raised for this order.',
                  })}
                </p>
              )}
            </div>
          }
          confirmLabel={
            editingDecisionId
              ? t('actions.save', { ns: 'common', defaultValue: 'Save' })
              : draft.action === 'ignored'
                ? t('lateOrders.confirmIgnore', { defaultValue: 'Ignore' })
                : t('lateOrders.confirmCoupon', { defaultValue: 'Continue to coupon' })
          }
          cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
          loading={busy}
          onConfirm={() => {
            // The reason is required; the dialog's own button cannot express
            // that, so an empty one is simply refused rather than committed.
            if (reason.trim()) void commit();
          }}
          onCancel={() => {
            setDraft(null);
            setEditingDecisionId(null);
            setActionTaken('');
          }}
        />
      )}

      {/*
        The same coupon form the Add-ticket page uses, and the same approval
        flow behind it. No ticket: a late order has an order and no complaint
        behind it, and `order_id` is what delivery actually needs.
      */}
      {coupon && (
        <CouponRequestDialog
          open
          onClose={() => setCoupon(null)}
          ticketId={null}
          orderId={coupon.row.orderId}
          contactId={coupon.contactId}
          /* NORMALISED, not Yiji's wire format. Yiji sends `+9665XXXXXXXX`;
             every phone this CRM stores and displays is `05XXXXXXXX` (owner's
             call, 2026-08-24). The ticket path already passes a normalised
             contact phone — this one passed the raw value straight through, so
             a late-order coupon reached the approvals queue titled
             `+966545808075` (owner, 2026-09-28). */
          customerPhone={normalizePhone(coupon.row.customerPhone) || null}
          /* Price rides along so picking an item can fill the coupon with what
             that item actually cost.
             
             NO SKU: `GetOrderCart` returns a display shape (name, qty, price,
             modifiers) and carries no item id at all. The ticket path gets one
             from the ORDER payload, which this queue does not fetch. Passing
             null is the honest answer — inventing a key from the name is
             exactly what `item_sku` exists to avoid. */
          orderItems={(couponCart.data?.lines ?? []).map((l) => ({
            name: l.name,
            price: l.price ?? null,
            sku: null,
          }))}
          description={coupon.reason}
          brandId={null}
          restaurantId={coupon.row.restaurantId ?? null}
          brandName={coupon.row.brandName ?? null}
          branchName={coupon.row.restaurantName ?? null}
          requestedBy={user?.id ?? null}
          onCreated={() => {
            /*
             * The coupon EXISTS now, so the decision is true and can be
             * written. If this fails the order stays in the queue with a
             * coupon already requested — visible and fixable, unlike a
             * register that claims a compensation nobody sent.
             */
            void record
              .mutateAsync({
                row: coupon.row,
                kind: coupon.kind,
                action: 'compensated',
                reason: coupon.reason,
                actionTaken: coupon.actionTaken,
                agentId: user?.id ?? null,
                ticketId: coupon.ticketId,
              })
              .catch(() =>
                toast.error(
                  t('lateOrders.recordFailed', {
                    defaultValue:
                      'The coupon was requested, but this order could not be marked handled.',
                  }),
                ),
              );
            setCoupon(null);
          }}
        />
      )}
    </div>
  );
}
