import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem } from '@directus/sdk';
import {
  Button,
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
  TablePager,
  TableSurface,
  Td,
  Th,
  Textarea,
  Tr,
  formatDate,
  formatDateTime,
  pageCountOf,
  toast,
  MultiSelectMenu,
  LongText,
} from '@yiji/ui';
import {
  lateOrderComplaintType,
  businessDay,
  businessDayRange,
  matchStore,
  normalizePhone,
  displayContactName,
  orderEventTimes,
  type LateOrderRow,
  causeRaisesTicket,
  DEFAULT_LATE_ORDER_CAUSES,
  type LateOrderGroup,
  lateOrderState,
  decidedOrdersAsQueueRows,
  type LateOrderState,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';
import { useStoreIndex } from '../tickets/useStoreMatch.js';
/* The ticket path's own shaper — one idea of what an order snapshot is. */
import { orderToSnapshot } from '../tickets/OrderSnapshotCard.js';
import { useVendors } from '../tickets/api.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';
import { LateOrderDetail } from './OrderDetail.js';
import { QuickReplies } from '../conversation/QuickReplies.js';
import {
  resolveLateOrderContact,
  useLateOrders,
  useLateOrderCauses,
  useLateOrderDecisions,
  useRecordLateDecision,
  useOrderEventTimes,
  useUpdateLateDecision,
  lateOrderTicket,
  FALLBACK_THRESHOLD,
} from './api.js';

/**
 * Rows per page. Starts at 25 — a queue is worked from the top, and a screenful
 * is what an agent reads; the larger sizes are for scanning a history range.
 * Capped at 50 because the duration batch is: the gateway takes 50 ids, so a
 * bigger page would blank the columns it cannot ask about.
 */
const LATE_ORDER_PAGE_SIZES = [10, 25, 50] as const;

/**
 * One of the three leg times: loading, not known, or a duration.
 *
 * A SKELETON and a DASH are different answers. The batch is still in flight, or
 * the two stamps this leg needs are not both in the order's history — an order
 * that never went out for delivery has no delivery time, and that is a fact, not
 * a gap. A zero would read as "instant" and is never shown.
 */
function LegTime({ loading, minutes }: { loading: boolean; minutes: number | null }) {
  if (loading)
    return (
      <span className="inline-block h-4 w-12 animate-pulse rounded bg-muted/60 align-middle" />
    );
  if (minutes === null) return <span className="text-muted-foreground/60">&mdash;</span>;
  return <span className="text-sm text-muted-foreground">{elapsed(minutes)}</span>;
}

/**
 * Late Delivery Handling - the agent's queue.
 *
 * Delivery orders past the threshold, in one of three states: PENDING until
 * somebody touches it, COMMENTED once an agent records why, HANDLED once a
 * coupon is assigned. Both acts demand a reason and both write to the SAME row
 * per order, which is what keeps one late order from growing two records.
 *
 * Commenting is deliberately not handling — an order can be explained and still
 * be waiting for a decision.
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

/** `YYYY-MM-DD`, n days ago, in the AGENT's own timezone rather than UTC. */
function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

interface DecisionDraft {
  row: LateOrderRow;
  action: 'commented' | 'compensated';
  /**
   * Opened by COMMENT rather than by the coupon button.
   *
   * Kept as a flag rather than inferred from `action`, because a comment on a
   * row that already carries one is an EDIT and a comment on a fresh row is the
   * first record — same button, two write paths, and `editingDecisionId` alone
   * cannot tell the coupon dialog apart from the comment one.
   */
  viewing?: boolean;
}

/**
 * Which branch `commit()` must take, and what the confirm button must say.
 *
 * EXPORTED, and used by the component below, so the tests exercise the real
 * thing. Re-stating this table in a test file would produce tests that pass
 * whatever the page does, which is worse than having none.
 *
 * A COMMENT IS NOW A RECORDED STATE (owner spec, 2026-09-29). It used to be
 * that the non-coupon button recorded an IGNORE, and a third button called View
 * read the notes back without deciding anything — so View on an undecided row
 * had to be prevented from writing. Ignore is gone; Comment is the one
 * non-coupon act, and it WRITES: first press creates the decision and moves the
 * order to `commented`, later presses edit the text. There is no longer any
 * path that opens this box and must refuse to save, so `noop` is gone with it.
 *
 * Commenting is deliberately NOT handling. Only a coupon marks an order
 * handled — but the button STAYS on a handled order (ops, 2026-10-04), because
 * the reason and action recorded with a coupon are exactly what gets typed in a
 * hurry and later needs correcting. Editing is safe: an existing decision
 * yields `'update'` below, which rewrites the wording and can never convert a
 * compensation back into a comment.
 */
export type DecisionOutcome = 'coupon' | 'update' | 'record-comment';

export function decisionOutcome(
  draft: { action: 'commented' | 'compensated'; viewing?: boolean },
  editingDecisionId: string | null,
): DecisionOutcome {
  if (draft.action === 'compensated') return 'coupon';
  /* A decision already exists for this order: the wording changes, the decision
     TYPE does not. Correcting a comment must never turn a compensation back
     into a comment. */
  if (editingDecisionId) return 'update';
  return 'record-comment';
}

/**
 * WHETHER THE DECISION CAN BE SAVED YET.
 *
 * The REASON is required in every case — a comment is a recorded state, so
 * there is no path that may save nothing.
 *
 * The ACTION is required only when a COUPON is being assigned (ops,
 * 2026-10-04: *"for assign a coupon, the reason and action both are mandatory.
 * currently action is optional."*). That is the case where something was
 * actually done, and a compensation whose action nobody wrote is a row the
 * register cannot explain — "why did this customer get money?" answered by a
 * blank cell.
 *
 * A plain comment still needs only the reason, which is the owner's earlier
 * call and still right (2026-09-28: *"no need action. just reason is
 * enough"*): writing the comment IS the act, so asking what was done about it
 * invites an empty box or a restatement of the line above.
 *
 * EDITING an existing decision requires both, because the action field is shown
 * then — a decision that already carries one must not be saveable with it
 * emptied.
 *
 * Exported so the test exercises the real rule rather than a restatement that
 * passes whatever the page happens to do.
 */
export function canCommit(
  draft: { action: 'commented' | 'compensated' },
  editingDecisionId: string | null,
  reason: string,
  actionTaken: string,
): boolean {
  if (!reason.trim()) return false;
  const actionRequired = draft.action === 'compensated' || !!editingDecisionId;
  return actionRequired ? !!actionTaken.trim() : true;
}

/**
 * Whether this decision must RAISE a ticket, REUSE one, or raise none.
 *
 * EXPORTED and used by the component, so the tests exercise the real rule
 * rather than a restatement of it that passes whatever the page does.
 *
 * - `none`    a WECARE cause. The owner's call (2026-09-28, reaffirmed
 *             2026-09-29): WeCare answers it themselves, no complaint is filed
 *             against a branch, and the case is NOT shared with operations.
 *             Late delivery is the seeded example.
 * - `reuse`   an OPERATIONS cause on an order whose earlier decision already
 *             raised one. Order 1323291 grew FOUR tickets from four decisions
 *             minutes apart, and the breakdown counted one complaint four
 *             times.
 * - `raise`   the first late-preparation decision on this order.
 */
export type TicketPlan = { mode: 'none' } | { mode: 'reuse'; id: string } | { mode: 'raise' };

export function planTicket(
  /**
   * THE GROUP decides, not the value (owner, 2026-09-29).
   *
   * It used to be `kind !== 'late_preparation'`, so a third cause could not be
   * added without editing this line. Now `operations` raises a ticket and
   * `wecare` does not, and a new cause is a row in `option_lists`.
   */
  group: LateOrderGroup | string | null | undefined,
  priorTicketId: string | null | undefined,
): TicketPlan {
  if (!causeRaisesTicket(group)) return { mode: 'none' };
  const prior = priorTicketId?.trim();
  return prior ? { mode: 'reuse', id: prior } : { mode: 'raise' };
}

/**
 * Where a not-yet-submitted classification is kept.
 *
 * The agent has told the screen what a late order IS; losing that on a reload
 * means the next coupon or ticket is filed under the wrong cause without
 * anybody being told (owner, 2026-09-29).
 */
const KINDS_KEY = 'yiji.lateOrders.kinds';

/**
 * At most this many orders remembered.
 *
 * A browser that never forgets would carry every order the agent has ever
 * glanced at, and `localStorage` is a few megabytes shared with everything else
 * on the origin. The queue itself holds far fewer than this at once, so the cap
 * only ever discards orders long since decided.
 */
const KINDS_LIMIT = 500;

export function readStoredKinds(): Record<string, string> {
  /* Every access wrapped: `localStorage` throws in a private window and in
     some embedded webviews, and a classification is not worth a blank page. */
  try {
    const raw = localStorage.getItem(KINDS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeStoredKinds(next: Record<string, string>): void {
  try {
    const entries = Object.entries(next);
    /* Newest kept: the object preserves insertion order, so the tail is the
       most recently classified. */
    const trimmed = entries.length > KINDS_LIMIT ? entries.slice(-KINDS_LIMIT) : entries;
    localStorage.setItem(KINDS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    /* Full, blocked or unavailable. The choice still holds for this page — it
       is in component state either way — so there is nothing to tell the
       agent that they could act on. */
  }
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
  /*
   * THE HANDLING FILTER — pending / commented / handled / all.
   *
   * Defaults to PENDING (owner, 2026-09-29): the queue exists to surface work
   * nobody has done, and opening on everything buries it under what is already
   * finished.
   *
   * Deliberately NOT called "open": that word already means an open TICKET in
   * this codebase, and the two side by side would read as the same thing.
   */
  const [handlingFilter, setHandlingFilter] = useState<LateOrderState | 'all'>('pending');
  /*
   * THE ORDER'S OWN STATUS — a different question entirely, multi-select.
   *
   * An EMPTY set means every status, which is what "All" selects. Holding it
   * as a set rather than an array keeps the membership test O(1) on a queue
   * that can run to thousands of rows.
   */
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<string>>(new Set());
  const [orderQuery, setOrderQuery] = useState('');
  const [brandQuery, setBrandQuery] = useState('');
  /*
   * OPENS ON TODAY'S BUSINESS DAY (owner, 2026-09-29).
   *
   * Both dates default to today, which is the shift an agent is working. It
   * used to open on the last 30 days with a separate "Live only" button; that
   * button is gone, because a date range covering today already answers "what
   * is late right now" and two controls for one question was the confusion.
   *
   * THE BUSINESS DAY, not the calendar date: trading runs 08:00 to 04:00, so
   * at 01:00 "today" is still yesterday's date and an agent working a night
   * shift must not lose the first half of it. `businessDayRange` gives the two
   * calendar dates that day touches — Yiji's filter understands dates, not
   * hours — and the rows are narrowed per row below.
   */
  const [dayTick, setDayTick] = useState(() => businessDay(new Date().toISOString()));
  useEffect(() => {
    /* One cheap check a minute, so 08:00 rolls the view over on its own. The
       state only changes on the one tick a day where the answer differs, so
       this is not a re-render every minute. */
    const id = setInterval(() => {
      const day = businessDay(new Date().toISOString());
      setDayTick((prev) => (prev === day ? prev : day));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  /*
   * ONE CONTRACT FOR `range`: `to` is the LAST DAY WANTED, INCLUSIVE.
   *
   * That is what the From/To pickers produce and what `getLateOrders`
   * documents ("the caller passes the last day they WANT; one day is added
   * here"). `businessDayRange` instead returns an EXCLUSIVE end — the day
   * after — so today was the odd one out, and every consumer had to guess
   * which kind of `to` it had been handed.
   *
   * That guess is what broke the decision query: it trusted the exclusive
   * form, which made a typed single-day search a zero-width window matching
   * nothing. Normalising here means a range means one thing everywhere.
   *
   * The business day still spans two CALENDAR dates — `businessDayRange` is
   * what knows that — so the inclusive last day is simply its exclusive end
   * minus one, which is the first of the two dates when the day has not yet
   * crossed midnight.
   */
  const todayRange = useMemo(() => {
    if (!dayTick) return null;
    const r = businessDayRange(dayTick);
    const at = Date.parse(`${r.to}T00:00:00Z`);
    if (!Number.isFinite(at)) return r;
    return { from: r.from, to: new Date(at - 24 * 60 * 60 * 1000).toISOString().slice(0, 10) };
  }, [dayTick]);

  const [draftFrom, setDraftFrom] = useState(() => isoDaysAgo(0));
  const [draftTo, setDraftTo] = useState(() => isoDaysAgo(0));
  /*
   * `null` means "today", and today is DERIVED so it rolls over at 08:00 while
   * the page is open. A night shift does not reload to get the right answer.
   * Searching a range stores it here and stops the rolling.
   */
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  /** The window actually asked for: a searched range, else today. */
  const activeRange = range ?? todayRange ?? undefined;
  /** True while showing today — which is the only window that still moves. */
  const showingToday = !range;

  const vendors = useVendors();

  /* The queue follows the range. Today is a range too — so finished orders
     stay on the list — but it is still live, so it keeps polling. */
  /* Today keeps polling — orders cross the threshold while an agent watches.
     A searched range is a fixed answer and does not. */
  const queue = useLateOrders(activeRange, true, showingToday);
  /* `useHandledLateOrders` is deliberately NOT used here any more (ops,
     2026-10-03). It asked only for the last 24 hours, so an order compensated
     the day before looked unhandled and the row offered a second coupon.
     `stateOf` below answers the same question from the decisions actually
     loaded for the range, with no time bound. */
  const record = useRecordLateDecision();

  /** The classification per row, defaulted to late delivery. */
  /*
   * THE CHOSEN CAUSE, PER ORDER — AND IT HAS TO SURVIVE (owner, 2026-09-29).
   *
   * This was component state, so an agent who set "Late preparation" and came
   * back to the page found it reading "Late delivery" again. The dropdown is a
   * DECISION being prepared, not a display toggle: losing it means the coupon
   * or the ticket is filed under the wrong cause, silently.
   *
   * `localStorage`, not `sessionStorage`: an agent who opens the queue in a
   * second tab is the same person working the same orders, and the sessions are
   * per-tab here precisely so two people can share a machine — the classification
   * of an order is not a per-tab fact.
   *
   * Keyed by order id and pruned on read, so a browser does not accumulate
   * every order the agent has ever looked at.
   */
  const [kinds, setKinds] = useState<Record<string, string>>(() => readStoredKinds());
  const [draft, setDraft] = useState<DecisionDraft | null>(null);
  const [reason, setReason] = useState('');
  /** What the agent DID about it — the second field, and editable later. */
  const [actionTaken, setActionTaken] = useState('');
  /** The decision being EDITED via Comments, when the row already has one. */
  const [editingDecisionId, setEditingDecisionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Whether the open decision dialog has everything it needs. `draft` is null
     when the dialog is closed, in which case there is nothing to validate. */
  const canCommitDecision = draft
    ? canCommit(draft, editingDecisionId, reason, actionTaken)
    : false;

  /*
   * "/" IN THE REASON BOX, exactly as in the chat composer.
   *
   * `null` means "not searching", DISTINCT from `''` which is a bare `/` with
   * nothing typed after it — the panel opens on the gesture itself, not on the
   * second keystroke. Same two values the composer derives, same reason.
   *
   * Only when the slash STARTS the box: mid-sentence a slash is a slash.
   */
  const reasonSlashMatch = /^\/(.*)$/.exec(reason);
  const reasonSlash = reasonSlashMatch?.[1] ?? '';
  const reasonSearching = reasonSlashMatch !== null;
  /* The same gesture in the Action box, against its OWN library. */
  const actionSlashMatch = /^\/(.*)$/.exec(actionTaken);
  const actionSlash = actionSlashMatch?.[1] ?? '';
  const actionSearching = actionSlashMatch !== null;
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
    /* A string, not the old two-value union: causes are an editable list now
       and operations add their own. */
    kind: string;
    ticketId: string | null;
    /**
     * Raises the ticket, LATER — only if the coupon request is actually made.
     *
     * Held as a function rather than an id because the ticket must not exist
     * until then: opening this form and closing it used to leave one behind
     * with no decision and no coupon (order 1323291 collected four).
     */
    raiseTicket?: () => Promise<string | null>;
    /**
     * Captures the order, LATER — only if the coupon request is actually made.
     *
     * Held as a function for the same reason as `raiseTicket`: opening the form
     * and closing it must cost nothing, and must leave nothing behind.
     */
    captureOrder?: () => Promise<unknown>;
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
   * THE ORDER ITSELF, for the Item field — the SAME source the tickets page
   * uses (owner, 2026-09-28: "it should be as similar to the regular assign
   * coupon from tickets page").
   *
   * The cart above is a DISPLAY shape: name, qty, price and modifiers, with no
   * item id. The order payload carries Yiji's `sku`, which is what `item_sku`
   * records — so a coupon raised from a late order was naming its item by a
   * spelling while one raised from a ticket named it by a key.
   *
   * The cart is still fetched: it is what Cart & tracking shows, and it has
   * the modifiers the order payload does not. Falls back to the cart's lines
   * when the order cannot be read, so the dropdown is never emptier than it
   * was before.
   */
  /*
   * The BRANCH the coupon is for, matched against the store master.
   *
   * Same match the ticket path uses, so a coupon raised from a late order names
   * its brand and branch exactly as one raised from a complaint does. Cheap:
   * the index is already loaded for the queue's own rows.
   */
  const couponStore = useMemo(
    () =>
      coupon
        ? matchStore(storeIndex, {
            restaurantId: coupon.row.restaurantId,
            restaurantName: coupon.row.restaurantName,
            brandName: coupon.row.brandName,
          })
        : null,
    [coupon, storeIndex],
  );

  const couponOrder = useQuery({
    queryKey: ['yiji-order', soleVendorId, coupon?.row.orderId],
    enabled: !!coupon?.row.orderId && !!soleVendorId,
    queryFn: () => commerce.getOrder(soleVendorId!, coupon!.row.orderId),
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
  /* What has already been decided — the source of the handling state, and what
     the Comment box opens populated from. Needed BEFORE `rows`, which filters
     on that state. */
  /* The SAME window the queue is showing, so the decisions behind these orders
     are the ones actually fetched — a fixed 30 days left an older search with
     five empty columns and no aged-out rows at all. */
  const decisions = useLateOrderDecisions(activeRange ?? undefined);
  /*
   * THE HANDLING STATE of one order: pending, commented or handled.
   *
   * `lateOrderState` is the shared rule, so this screen, the register and the
   * summary can never disagree about what "handled" means.
   */
  const stateOf = useCallback(
    (orderId: string): LateOrderState => lateOrderState(decisions.data?.get(orderId) ?? null),
    [decisions.data],
  );

  /** The decision for an order, or null while it is still pending. */
  const decisionOf = useCallback(
    (orderId: string) => decisions.data?.get(orderId) ?? null,
    [decisions.data],
  );

  /*
   * The order statuses actually PRESENT in the window, for the filter.
   *
   * Derived from the rows rather than enumerated from Yiji's full vocabulary:
   * a menu of twenty statuses, eighteen of which return nothing, is a menu that
   * has stopped helping. Same rule the business-day and agent pickers follow.
   *
   * Computed from the UNFILTERED queue, so choosing a status never removes the
   * other options from the menu that offered it.
   */
  /*
   * EVERY LATE ORDER THIS SCREEN SHOULD KNOW ABOUT — live AND already decided.
   *
   * The queue is live: Yiji answers with orders currently past the threshold,
   * and an order drops out once it is old enough. Our DECISION against it never
   * drops out. Filtering the queue alone therefore lost this screen's own
   * history, which is what operations reported (2026-10-03): "not showing any
   * data for yesterday or day before", while the same orders sat plainly in the
   * admin register — which has always merged the two sources.
   *
   * `decidedOrdersAsQueueRows` rebuilds the missing ones from the snapshot
   * captured when the agent decided, in the queue's own shape, so everything
   * downstream — the filters, the pickers, the business-day cut, the table —
   * keeps reading one kind of row. A live order is never duplicated: the live
   * row wins, because it is current and a snapshot is a copy of one moment.
   */
  const allOrders = useMemo(() => {
    const live = queue.data?.rows ?? [];
    const decided = decidedOrdersAsQueueRows([...(decisions.data?.values() ?? [])], live);
    return [...live, ...decided];
  }, [queue.data, decisions.data]);

  const presentStatuses = useMemo(() => {
    const seen = new Set<string>();
    for (const r of allOrders) if (r.status) seen.add(r.status);
    return [...seen].sort();
  }, [allOrders]);

  const rows = useMemo(() => {
    const order = orderQuery.trim();
    const brand = brandQuery.trim().toLowerCase();
    return allOrders.filter((r) => {
      /*
       * TODAY MEANS TODAY'S BUSINESS DAY, not the calendar date.
       *
       * Trading runs 08:00 to 04:00, so a calendar cut splits one night's work
       * in two: an order at 01:00 is still tonight's trading and an order at
       * 06:00 belongs to the night that just ended. Only applied while showing
       * today — a searched range is whatever the agent asked for.
       */
      if (showingToday && businessDay(r.placedAt) !== currentBusinessDay) return false;

      /*
       * THE HANDLING STATE — pending / commented / handled.
       *
       * NOT the order's own status, which is filtered separately below. An
       * order can be `force_closed` upstream and still `pending` here, because
       * nobody has touched it (owner, 2026-09-29: do not mix these).
       */
      if (handlingFilter !== 'all' && stateOf(r.orderId) !== handlingFilter) return false;

      /*
       * THE ORDER'S OWN STATUS — multi-select, so several can be watched at
       * once. An empty set means every status, which is what "All" selects.
       */
      if (statusFilter.size > 0 && !statusFilter.has(r.status)) return false;

      if (order && !r.orderId.includes(order)) return false;
      if (brand && !`${r.brandName ?? ''} ${r.restaurantName ?? ''}`.toLowerCase().includes(brand))
        return false;
      return true;
    });
  }, [
    allOrders,
    orderQuery,
    brandQuery,
    showingToday,
    currentBusinessDay,
    handlingFilter,
    statusFilter,
    stateOf,
  ]);

  /*
   * SERVICE TIME for the rows actually on screen.
   *
   * Driver-accept is not in the late-orders list; it is one status-history call
   * per order. Asking for the whole queue would be hundreds of calls into
   * Yiji's production API per page load, so this asks only for what is
   * rendered. `nowMs` ticks with the queue's own refresh so a live order's
   * service time advances with everything else rather than freezing at mount.
   */
  /*
   * PAGED, like the report tables (owner, 2026-09-30).
   *
   * Two reasons, and the second is a real fault rather than a preference:
   *
   *   1. a history range returns hundreds of rows, and rendering them all is
   *      what made the scroll feel wrong;
   *   2. the batch below was handed EVERY row's id while its own comment
   *      claimed "the rows actually on screen". The gateway caps a batch at 50,
   *      so on a long queue every row past the fiftieth silently showed blank
   *      duration columns — a plausible gap that reads as "not known" rather
   *      than as truncation. See [[silent-empty-failures]].
   */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const pageCount = pageCountOf(rows.length, pageSize);
  /* Clamped rather than stored: narrowing the filters while sitting on page 9
     must not strand the agent on a page that no longer exists. */
  const current = Math.min(Math.max(1, page), pageCount);
  const paged = useMemo(
    () => rows.slice((current - 1) * pageSize, current * pageSize),
    [rows, current, pageSize],
  );
  const eventTimes = useOrderEventTimes(paged.map((r) => r.orderId));
  /*
   * THE CAUSES, from the editable list (owner, 2026-09-29).
   *
   * Operations add and retire these in the admin portal; the GROUP on each row
   * is what decides whether the decision also files a ticket.
   */
  const causes = useLateOrderCauses();
  /* `fetchQuery`, not a hook: the order is wanted at the MOMENT of deciding,
     which is an event, not a render. Going through the cache means a row whose
     cart was already opened costs nothing. */
  const qc = useQueryClient();
  const causeOptions = useMemo(() => {
    const list = causes.data?.length ? causes.data : [...DEFAULT_LATE_ORDER_CAUSES];
    return list.map((c) => ({
      value: c.value,
      /* The seeded two keep their translations; anything operations add shows
         the value they typed, which is the only honest label for it. */
      label: t(`lateOrders.kind.${c.value}`, { defaultValue: c.value }),
      /* The dot carries the OWNER at a glance — amber for a cause that files a
         complaint against a branch, blue for one WeCare answers alone. */
      dot: c.group === 'operations' ? 'oklch(var(--warning))' : 'oklch(var(--sky))',
    }));
  }, [causes.data, t]);
  const updateDecision = useUpdateLateDecision();
  const nowMs = queue.dataUpdatedAt || Date.now();

  /*
   * THE FOUR TIMES for a row, from its status history.
   *
   * `orderEventTimes` is the one place the rules live — Closed beats
   * force-closed, each fallback is named, and a missing pair is null rather
   * than zero. Computed at render against `nowMs` so a live order's service
   * time ticks with the queue's own refresh.
   */
  const timesOf = useCallback(
    (orderId: string) => orderEventTimes(eventTimes.data?.[orderId] ?? {}, nowMs),
    [eventTimes.data, nowMs],
  );

  /*
   * What this order is classified as, in order of authority:
   *
   *   1. WHAT THE AGENT PICKED. Held in `kinds`, written through to storage and,
   *      when a decision row exists, to that row as well.
   *   2. the decision already recorded, for a row this browser has never touched;
   *   3. the first cause on the list.
   *
   * THE PICK WINS, and that ordering is the §5 fix (owner spec, 2026-09-29:
   * "the source of delay selected ... should persist ... fix the underlying
   * state, not visually"). It used to be the other way round — the recorded
   * decision beat the agent's pick — which was harmless while every decision was
   * final: a decided order left the queue, so the two could not disagree for
   * long. Under the new state model a COMMENTED order stays on the queue and
   * stays workable, so a recorded `kind` sat permanently on top of the dropdown:
   * the agent changed it, the select moved, and the next refetch of the decisions
   * query (a 30s poll, or any search that revalidates) put the old value straight
   * back. Nothing was broken about the control; the precedence was wrong.
   *
   * (3) was hardcoded `'late_delivery'`, which is wrong twice over: it ignores
   * the order operations put the list in, and it would keep naming a cause that
   * had been retired.
   */
  const kindOf = (row: LateOrderRow): string => {
    const picked = kinds[row.orderId];
    if (picked) return picked;
    const decided = decisions.data?.get(row.orderId)?.kind;
    if (decided) return decided;
    return causeOptions[0]?.value ?? 'late_delivery';
  };

  /**
   * The agent reclassified this order.
   *
   * Two places to keep in step, and both matter. `kinds` is what the dropdown
   * reads and what survives a reload; the DECISION ROW is what the register and
   * the reports read. Writing only the first left the register naming the old
   * cause for ever, with nothing on screen to suggest a disagreement.
   *
   * The decision write is best-effort: the pick is already held locally, so a
   * failed PATCH must not throw away the agent's choice or interrupt them
   * mid-queue. `invalidateQueries` in the mutation brings the row back in step
   * on success.
   */
  const pickKind = (orderId: string, value: string) => {
    setKinds((cur) => {
      const next = { ...cur, [orderId]: value };
      writeStoredKinds(next);
      return next;
    });
    const existing = decisions.data?.get(orderId);
    if (existing?.id && existing.kind !== value) {
      updateDecision.mutate({ id: existing.id, kind: value });
    }
  };

  const openDecision = (
    row: LateOrderRow,
    action: 'commented' | 'compensated',
    viewing = false,
  ) => {
    /*
     * Seeded from the decision already recorded, when there is one.
     *
     * The Comments button reopens this same box on a row that has been
     * decided, so it must show what was written rather than a blank form an
     * agent would have to retype.
     */
    const existing = decisions.data?.get(row.orderId);
    setDraft({ row, action, viewing });
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
      /* The CONTACT, per the owner's spec. Without it the branch gets a
         complaint with nobody attached, the ticket cannot be found by
         searching the number that raised it, and the coupon request names
         nobody. Resolved ONCE here and reused by both paths. */
      const contactId = await resolveLateOrderContact(draft.row, soleVendorId);
      /*
       * ONE ORDER, ONE TICKET (owner, 2026-09-28).
       *
       * Order 1323291 grew FOUR tickets: an agent submitted four decisions
       * minutes apart and each raised its own. They are the same complaint
       * about the same order, so the breakdown report counted one late
       * preparation four times.
       *
       * A repeat decision now reuses the ticket the first one raised. Read from
       * the DECISION rather than searched for by order id: the decision is
       * where the link was recorded, so this cannot pick up a ticket somebody
       * raised by hand for the same order from the tickets page.
       */
      /*
       * THE TICKET IS RAISED ONLY WHEN SOMETHING IS ACTUALLY DECIDED.
       *
       * It used to be raised HERE, before the coupon form opened — so an agent
       * who opened the form and closed it left a ticket behind with no decision
       * and no coupon. Order 1323291 collected FOUR of them that way (owner,
       * 2026-09-28), and none of the four had a decision or a coupon behind it.
       *
       * The comment above already recorded this lesson for the DECISION: "an
       * agent who opens the form and closes it leaves a permanent row claiming
       * the customer was compensated when nothing was ever sent." The ticket is
       * the same kind of row and needed the same treatment.
       *
       * So it is a function now, called on IGNORE immediately (the decision is
       * the whole act) and on COMPENSATE only once the coupon request exists.
       * Returns `null` when there is nothing to raise, and throws when it
       * cannot be raised honestly — the caller stops rather than half-finishing.
       */
      /*
       * THE ORDER, FETCHED ONCE, AT THE MOMENT OF DECIDING (owner, 2026-09-29).
       *
       * The same endpoint the inbox uses for its order detail —
       * `/commerce/order`, keyed by order id — so a late order records exactly
       * what a chat records. `orderToSnapshot` is the ticket path's own shaper,
       * reused rather than restated.
       *
       * NOT on page load. The queue can hold hundreds of rows and only a
       * handful are ever decided; one call per row would be hundreds into
       * Yiji's production API every time the page opens, for data nobody asked
       * for.
       *
       * Best-effort: a decision must not be lost because the order could not be
       * read. The reason, the branch and the elapsed time are already on the
       * row; the snapshot is additional detail, not the record itself.
       */
      const captureOrder = async (): Promise<unknown> => {
        if (!soleVendorId) return null;
        try {
          const order = await qc.fetchQuery({
            queryKey: ['yiji-order', soleVendorId, draft.row.orderId],
            queryFn: () => commerce.getOrder(soleVendorId, draft.row.orderId),
            staleTime: 5 * 60_000,
          });
          return order ? { ...orderToSnapshot(order), capturedAt: new Date().toISOString() } : null;
        } catch {
          return null;
        }
      };

      const raiseTicketIfNeeded = async (): Promise<string | null> => {
        const priorTicketId = decisions.data?.get(draft.row.orderId)?.ticket ?? null;
        /* The GROUP of the chosen cause, from the editable list. Falls back to
           the seeded default so a list that cannot be read still behaves as the
           code always did rather than filing nothing. */
        const group =
          causes.data?.find((c) => c.value === kind)?.group ??
          DEFAULT_LATE_ORDER_CAUSES.find((c) => c.value === kind)?.group;
        const plan = planTicket(group, priorTicketId);
        if (plan.mode === 'none') return null;
        // Already filed for this order: reuse it rather than stacking another.
        if (plan.mode === 'reuse') return plan.id;

        /* The branch, resolved from the store master. Without it the ticket has
           no `restaurantName`, and a ticket nobody can attribute is worse than
           none — see below. */
        const storeMatch = matchStore(storeIndex, {
          restaurantId: draft.row.restaurantId,
          restaurantName: draft.row.restaurantName,
          brandName: draft.row.brandName,
        });
        /*
         * NO BRANCH, NO TICKET (owner, 2026-09-28).
         *
         * Order 1280043 raised ticket bc7dac2d with `store: null`, which
         * existed in the database and never appeared in the breakdown. Creating
         * it anyway is worse than refusing: the agent believes it is filed and
         * nobody can find it. The message names the branch the order came from,
         * so whoever sees it can fix the store master rather than guess.
         */
        if (!storeMatch?.store?.id) {
          throw new Error(
            t('lateOrders.noBranchForTicket', {
              branch: draft.row.restaurantName || draft.row.restaurantId || '?',
              defaultValue:
                'No branch in the store master matches "{{branch}}", so this ticket would be hidden from reports. Add it first.',
            }),
          );
        }
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
              storeMatch,
            }) as never,
          ),
        )) as { id: string };
        return created?.id ?? null;
      };
      /* ONE source for which branch this takes — `decisionOutcome` is exported
         and tested, so the four cases cannot drift apart. */
      const outcome = decisionOutcome(draft, editingDecisionId);
      if (outcome === 'coupon') {
        /* NOTHING IS RECORDED YET — not the decision, and now not the ticket
           either. Both are written by the coupon form's own success path, once
           a request actually exists. Opening this form and closing it must
           leave the order exactly as it was. */
        setCoupon({
          row: draft.row,
          reason: text,
          actionTaken,
          kind,
          ticketId: null,
          contactId,
          raiseTicket: raiseTicketIfNeeded,
          captureOrder,
        });
      } else if (outcome === 'update') {
        /* Editing an existing decision: only the wording changes. The decision
           TYPE stays as it was taken — fixing a typo must not turn an ignore
           into a compensation. */
        await updateDecision.mutateAsync({
          id: editingDecisionId!,
          reason: text,
          actionTaken,
        });
        toast.success(t('lateOrders.commentSaved', { defaultValue: 'Comment saved.' }));
      } else {
        /* THE FIRST COMMENT ON THIS ORDER, so it creates the decision row that
           carries the `commented` state. Any ticket the cause demands is raised
           FIRST, so a failure here leaves nothing half-done: no ticket, no
           decision, and the order still pending for somebody to work.

           ONE ROW PER ORDER — this branch is reached only when no decision
           exists (`editingDecisionId` is null), which is what keeps a second
           comment from filing a duplicate late-order record. */
        const commentTicketId = await raiseTicketIfNeeded();
        /* The order as it stood, captured for a comment too — a comment is a
           recorded state now, and the register shows the order beside it. */
        const orderSnapshot = await captureOrder();
        await record.mutateAsync({
          row: draft.row,
          kind,
          action: 'commented',
          reason: text,
          actionTaken,
          agentId: user?.id ?? null,
          ticketId: commentTicketId,
          orderSnapshot,
        });
        toast.success(t('lateOrders.commentSaved', { defaultValue: 'Comment saved.' }));
      }
      setDraft(null);
      setReason('');
      setActionTaken('');
      setEditingDecisionId(null);
    } catch (err) {
      /* The SPECIFIC message when there is one — `raiseTicketIfNeeded` throws a
         named error for a branch the store master does not have, and telling
         the agent "could not record that decision" instead would hide the one
         thing they can act on. */
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t('lateOrders.decisionFailed', { defaultValue: 'Could not record that decision.' }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    /*
      THE SAME THREE-PART SHELL THE REPORT TABLES USE (owner, 2026-09-30: "make
      this table like how we have the other tables", reference: Operational KPI
      -> Ticket breakdown).

      My first pass at §8 put `h-full overflow-y-auto` on this one element. That
      moved the scroll to the page as the spec asked, but it also made this the
      scrollport for a `TableSurface flow` — whose whole bargain is that NOTHING
      sits between its sticky header and the scrollport. With the gap-4 flex
      column as that scrollport, a table wider than the viewport had nothing
      establishing its width, so rows ran outside the card and the scroll fought
      itself.

      The working pattern, copied from `AgentReportsPage`, is three nested parts
      and every one of them matters:

        1. this root — `h-full flex-col overflow-hidden`: owns the height, scrolls
           nothing, and clips so the shell's `<main>` (also `overflow-hidden`)
           never has to;
        2. the scrollport below — `flex-1 overflow-auto` with NO vertical padding,
           because `sticky top-0` pins to the scrollport's CONTENT box and padding
           there leaves a band above the header with rows sliding through it;
        3. an inner `w-max min-w-full` — which is what makes a wide table stretch
           the scrollport instead of overflowing the card.

      See [[layout-height-budget]]: the law is measure the remainder, and here the
      remainder is measured by flex rather than guessed.
    */
    <div className="flex h-full flex-col overflow-hidden">
      {/*
        THE SCROLLPORT. `flex-1 overflow-auto`, and NO vertical padding: `sticky
        top-0` pins to this element's CONTENT box, so padding here would leave a
        band above the table's pinned header with rows sliding through it. The
        vertical spacing lives on the child instead, where it is spacing rather
        than a hole in the sticky ceiling.

        The scrollbar is styled visibly on purpose: the app's global thumb is
        deliberately faint, which is right for a page and wrong for the one
        control that reaches the far columns of a wide table.
      */}
      <div className="[&::-webkit-scrollbar]:h-3.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/25 hover:[&::-webkit-scrollbar-thumb]:bg-foreground/40 [&::-webkit-scrollbar-track]:bg-foreground/[0.06] [scrollbar-width:auto] flex-1 overflow-auto px-4">
        {/* `w-max min-w-full` is the part that fixes "records outside the
            table": it lets the content be as wide as the table needs while
            never narrower than the viewport, so a wide table stretches this box
            and scrolls it, instead of spilling past the card's edge. */}
        <div className="w-max min-w-full space-y-4 py-4">
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
                placeholder={t('lateOrders.filter.orderPlaceholder', {
                  defaultValue: 'e.g. 1314302',
                })}
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
              <DateField
                value={draftTo}
                max={today}
                onChange={(v) => setDraftTo(v)}
                className="w-40"
              />
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
            {/* Applied on click, not per keystroke: a range walks upstream pages,
            so typing a date would fire a query per character. */}
            {/*
              BRAND FILL, NOT GREY (owner, 2026-10-05: "the search button being
              gray is not very visible").

              It was `secondary`, which is the same muted grey as the row of
              filter labels it sits among — so the one control that actually
              RUNS the query looked like another piece of chrome. This is the
              page's primary action: nothing on screen changes until it is
              pressed, because a date range deliberately does not query per
              keystroke. It has to look like the thing to press.
            */}
            <Button
              variant="brand"
              disabled={!draftFrom || !draftTo || draftFrom > draftTo}
              onClick={() => setRange({ from: draftFrom, to: draftTo })}
            >
              {t('lateOrders.filter.apply', { defaultValue: 'Search' })}
            </Button>

            {/*
          THE HANDLING STATE — what WeCare has done, not what the order is.
          Opens on Pending, because the queue exists to surface work nobody has
          done yet (owner, 2026-09-29).
        */}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t('lateOrders.filter.handling', { defaultValue: 'Status' })}
              <SelectMenu
                value={handlingFilter}
                size="sm"
                onChange={(v) => setHandlingFilter(v as LateOrderState | 'all')}
                aria-label={t('lateOrders.filter.handling', { defaultValue: 'Status' })}
                options={[
                  {
                    value: 'pending',
                    label: t('lateOrders.state.pending', { defaultValue: 'Pending' }),
                    dot: 'oklch(var(--warning))',
                  },
                  {
                    value: 'commented',
                    label: t('lateOrders.state.commented', { defaultValue: 'Commented' }),
                    dot: 'oklch(var(--sky))',
                  },
                  {
                    value: 'handled',
                    label: t('lateOrders.state.handled', { defaultValue: 'Handled' }),
                    dot: 'oklch(var(--success))',
                  },
                  {
                    value: 'all',
                    label: t('lateOrders.filter.allStates', { defaultValue: 'All' }),
                  },
                ]}
              />
            </label>

            {/*
          THE ORDER'S OWN STATUS — a different question, and several can be
          watched at once. Offered from the statuses actually PRESENT in the
          window, so every option returns rows.
        */}
            <MultiSelectMenu
              selected={statusFilter}
              onChange={setStatusFilter}
              label={t('lateOrders.filter.orderStatus', { defaultValue: 'Order status' })}
              allLabel={t('lateOrders.filter.allStatuses', { defaultValue: 'All statuses' })}
              options={presentStatuses.map((v) => ({
                value: v,
                label: t(`commerce.orderStatuses.${v}`, { defaultValue: v }),
              }))}
            />

            {/* Back to the default view: today, pending, nothing typed. */}
            <Button
              variant="ghost"
              onClick={() => {
                setRange(null);
                setDraftFrom(isoDaysAgo(0));
                setDraftTo(isoDaysAgo(0));
                setOrderQuery('');
                setBrandQuery('');
                setHandlingFilter('pending');
                setStatusFilter(new Set());
              }}
            >
              {t('lateOrders.filter.reset', { defaultValue: 'Reset' })}
            </Button>

            {/* Names the business day, because "today" is not the calendar date
            here: trading runs 08:00 to 04:00, so at 01:00 the answer is still
            yesterday's date and an agent has to see which day they are on. */}
            {showingToday && (
              <Pill tone="success" size="sm">
                {t('lateOrders.filter.todayNote', {
                  day: currentBusinessDay ? formatDate(currentBusinessDay) : '',
                  defaultValue: 'Business day {{day}} — every late order, finished or running',
                })}
              </Pill>
            )}
            {!showingToday && range && (
              <Pill tone="blue" size="sm">
                {t('lateOrders.filter.historyNote', {
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
                defaultValue:
                  'No delivery order has passed {{minutes}} minutes. This updates itself.',
              })}
            />
          ) : (
            /*
          `TableSurface flow`, not a `Card` with its own scroll.

          This is the primitive the report tables already use for exactly this
          bargain: every row really rendered, no scroller between the header and
          the page, so `sticky` resolves against the page's scrollport and the
          column names stay put as you read down. A `Card` with `overflow-auto`
          gave the table its own scrollbar — the thing §8 rejects — and using the
          shared surface means this page cannot drift from the five reports that
          got it right.
        */
            /* A FRAGMENT: this ternary branch now holds the table AND its pager,
           and a branch may only produce one node. */
            <>
              <TableSurface
                flow
                scrollLabel={t('lateOrders.title', { defaultValue: 'Late orders' })}
              >
                <Table>
                  <thead>
                    <Tr>
                      {/*
                  WHEN THE DECISION WAS TAKEN, and the business day it belongs
                  to (owner, 2026-10-01: the queue should show what the admin
                  register shows). Blank while an order is still pending —
                  nobody has decided anything yet, and dating it "now" would be
                  a claim rather than a fact.
                */}
                      <Th>{t('lateOrders.col.created', { defaultValue: 'Creation time' })}</Th>
                      <Th>{t('lateOrders.col.businessDay', { defaultValue: 'Business day' })}</Th>
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
                          {t('lateOrders.col.serviceHint', {
                            defaultValue: 'since driver accepted',
                          })}
                        </span>
                      </Th>
                      {/*
                  THE THREE LEGS (owner spec §7, 2026-09-29), beside the service
                  time they break down. Each names what it measures underneath,
                  because "Delivery" and "Service" are otherwise indistinguishable
                  at a glance and they start from different moments.
                */}
                      <Th>
                        {t('lateOrders.col.driverArrival', { defaultValue: 'Driver arrival' })}
                        <span className="block text-[10px] font-normal normal-case text-muted-foreground">
                          {t('lateOrders.col.driverArrivalHint', {
                            defaultValue: 'accept to arrival',
                          })}
                        </span>
                      </Th>
                      <Th>
                        {t('lateOrders.col.delivery', { defaultValue: 'Delivery time' })}
                        <span className="block text-[10px] font-normal normal-case text-muted-foreground">
                          {t('lateOrders.col.deliveryHint', {
                            defaultValue: 'out for delivery to close',
                          })}
                        </span>
                      </Th>
                      <Th>
                        {t('lateOrders.col.preparation', { defaultValue: 'Preparation time' })}
                        <span className="block text-[10px] font-normal normal-case text-muted-foreground">
                          {t('lateOrders.col.preparationHint', {
                            defaultValue: 'accepted to ready',
                          })}
                        </span>
                      </Th>
                      {/* SPLIT, like the register: brand and restaurant are two
                  facts, and one joined cell cannot be sorted or read as
                  either. */}
                      <Th>{t('lateOrders.col.brandOnly', { defaultValue: 'Brand' })}</Th>
                      <Th>{t('lateOrders.col.restaurant', { defaultValue: 'Restaurant' })}</Th>
                      <Th>{t('lateOrders.col.customer', { defaultValue: 'Customer mobile' })}</Th>
                      <Th>{t('lateOrders.col.status', { defaultValue: 'Order status' })}</Th>
                      <Th>{t('lateOrders.col.kind', { defaultValue: 'Source of delay' })}</Th>
                      {/* WHAT WAS DECIDED, and by whom — the three the register
                  carries and the queue did not. */}
                      <Th>{t('lateOrders.col.agent', { defaultValue: 'Agent' })}</Th>
                      <Th>{t('lateOrders.col.reason', { defaultValue: 'Reason' })}</Th>
                      <Th>{t('lateOrders.col.actionTaken', { defaultValue: 'Action taken' })}</Th>
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
                      {/* COMMENTS, not Notes (owner spec §9, 2026-09-29) — one word
                    for one thing, so the column, the button and the state all
                    read the same. */}
                      <Th>{t('lateOrders.col.comments', { defaultValue: 'Comments' })}</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {paged.map((row) => (
                      <Fragment key={row.orderId}>
                        <Tr>
                          {/* The decision's own timestamp and business day. A
                              pending order has neither — nothing has been
                              decided — and a dash says so honestly. */}
                          <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                            {decisions.data?.get(row.orderId)?.date_created
                              ? formatDateTime(decisions.data.get(row.orderId)!.date_created!)
                              : '-'}
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                            {businessDay(decisions.data?.get(row.orderId)?.date_created ?? null) ??
                              '-'}
                          </Td>
                          <Td className="whitespace-nowrap font-medium tabular-nums">
                            {row.orderId}
                          </Td>
                          {/*
                      A NUMBER, NOT A FILLED PILL (owner, 2026-09-28: "has some
                      orange color which hides the number").

                      The amber pill put amber text on an amber ground, so the
                      figure this whole screen exists to communicate was the
                      least readable thing on the row.

                      ALWAYS RED, not amber-then-red (owner, 2026-09-28). Every
                      row in this queue is ALREADY past the threshold — that is
                      what put it here — so a two-tone scale was drawing a
                      distinction between "late" and "later" that nobody asked
                      for, and it made half the column the washed-out amber the
                      change set out to remove.
                    */}
                          <Td className="whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums text-destructive">
                              <span
                                aria-hidden="true"
                                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
                              />
                              {elapsed(row.minutesElapsed)}
                            </span>
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
                              if (eventTimes.isLoading)
                                return (
                                  /* A skeleton, not a spinner: one spinner per row
                               reads as a page that is broken, and the width is
                               known so nothing reflows when the value lands. */
                                  <span className="inline-block h-4 w-12 animate-pulse rounded bg-muted/60 align-middle" />
                                );
                              /* `orderEventTimes`, not the old `serviceMinutes`:
                           that one took the queue's `closedAt`, which is the
                           CURRENT status's moment and so reads a force-close as
                           the end. Order 1323407 was closed at 17:30 and
                           force-closed at 22:31, giving 365 minutes where the
                           truth is 64 (owner spec §6). */
                              const mins = timesOf(row.orderId).serviceMinutes;
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
                                /* Same weight and size as Total time beside it, so
                             the two read as a pair to compare rather than a
                             headline and a footnote. */
                                /* AMBER, and deliberately NOT the red beside it
                             (owner, 2026-09-28: "service time should be in a
                             color"). Two different measures in the same row
                             must not wear the same colour, or the eye reads
                             them as one number split in two. Amber also carries
                             "still running" on its own. */
                                <span className="inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums text-warning-foreground">
                                  <span
                                    className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning"
                                    aria-hidden="true"
                                  />
                                  {elapsed(mins)}
                                  <span className="sr-only">
                                    {t('lateOrders.serviceLive', {
                                      defaultValue: 'still counting',
                                    })}
                                  </span>
                                </span>
                              ) : (
                                /* Settled: a filled dot rather than a pulsing one, and
                             muted — the figure is final, not climbing. */
                                <span className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums text-muted-foreground">
                                  <span
                                    aria-hidden="true"
                                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                                  />
                                  {elapsed(mins)}
                                </span>
                              );
                            })()}
                          </Td>
                          {/* The three legs. Same loading/blank treatment as the
                        service time beside them, via one helper — three copies
                        of "skeleton, else dash, else minutes" is three chances
                        for one of them to say something different. */}
                          <Td className="whitespace-nowrap tabular-nums">
                            <LegTime
                              loading={eventTimes.isLoading}
                              minutes={timesOf(row.orderId).driverArrivalMinutes}
                            />
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums">
                            <LegTime
                              loading={eventTimes.isLoading}
                              minutes={timesOf(row.orderId).deliveryMinutes}
                            />
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums">
                            <LegTime
                              loading={eventTimes.isLoading}
                              minutes={timesOf(row.orderId).preparationMinutes}
                            />
                          </Td>
                          <Td className="max-w-[12rem] truncate">{row.brandName || '-'}</Td>
                          <Td className="max-w-[14rem] truncate">{row.restaurantName || '-'}</Td>
                          <Td className="whitespace-nowrap">
                            {/* NORMALISED FOR DISPLAY, not just for storage. Yiji
                          sends `+9665XXXXXXXX`; every number in this CRM reads
                          `05XXXXXXXX`, and this cell was the one place showing
                          Yiji's shape to an agent (owner, 2026-09-28). */}
                            {displayContactName(row.customerName, row.customerPhone) ||
                              normalizePhone(row.customerPhone) ||
                              '-'}
                          </Td>
                          <Td className="whitespace-nowrap text-muted-foreground">
                            {t(`commerce.orderStatuses.${row.status}`, {
                              defaultValue: row.status,
                            })}
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
                              onChange={(v) => pickKind(row.orderId, v)}
                              options={causeOptions}
                            />
                          </Td>
                          {/*
                      WHAT WAS DECIDED — the three the register carries, so an
                      agent reads the same facts here as a manager reads there
                      (owner, 2026-10-01). Blank on a pending order, because
                      nobody has decided anything yet.
                    */}
                          <Td className="whitespace-nowrap">
                            {decisions.data?.get(row.orderId)?.decided_by?.first_name || '-'}
                          </Td>
                          {/*
                      THE FULL TEXT ON HOVER (ops, 2026-10-04: *"On hover, the
                      Reason and Action should display the full data"*).

                      `title` alone was not enough. It is a native tooltip:
                      invisible on a touch screen, invisible to a keyboard user,
                      slow to appear, and it cannot wrap a long reason legibly —
                      the same objection the quick-replies panel already
                      answered. `LongText` renders the whole value in a panel on
                      hover AND on focus, and keeps `title` as the plain-text
                      fallback.
                    */}
                          <Td className="max-w-[18rem]">
                            <LongText value={decisionOf(row.orderId)?.reason} />
                          </Td>
                          <Td className="max-w-[18rem]">
                            <LongText value={decisionOf(row.orderId)?.action_taken} />
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
                            {/*
                        A DECIDED ORDER SHOWS ITS DECISION, IN EVERY VIEW
                        (owner, 2026-09-28).

                        This was gated on `range`, so on the live queue a row
                        that had just been decided still offered Assign coupon
                        and Ignore — inviting a second, contradictory record for
                        the same order. What decides this is whether a decision
                        EXISTS, not which view happens to be open.
                      */}
                            {/*
                        `stateOf`, NOT the `handled` set (ops, 2026-10-03).

                        `useHandledLateOrders` only ever asks for the last 24
                        HOURS, so an order compensated the day before was absent
                        from it, this test read false, and the row offered
                        "Assign coupon" on an order that plainly had a coupon.
                        Filter by Status = Handled on any older range and EVERY
                        row showed the button.

                        The page already knows the right answer — `stateOf` is
                        what the status filter itself uses, and `lateOrderState`
                        has no time bound at all. The same mistake as the `range`
                        gate this replaced: deciding from the view that happens
                        to be loaded rather than from whether a decision EXISTS.
                      */}
                            {stateOf(row.orderId) === 'handled' ? (
                              <Pill tone="success" size="sm">
                                {t('lateOrders.alreadyHandled', { defaultValue: 'Handled' })}
                              </Pill>
                            ) : (
                              /*
                          ONE DECISION, AND ONLY ONE (owner spec, 2026-09-29):
                          assign a coupon. Ignore is gone — it was a second
                          recorded outcome that meant "no compensation", which
                          is what a comment already says, and having both invited
                          two contradictory records for one order.
                        */
                              <Button size="sm" onClick={() => openDecision(row, 'compensated')}>
                                {t('lateOrders.assignCoupon', { defaultValue: 'Assign coupon' })}
                              </Button>
                            )}
                          </Td>
                          {/*
                      COLUMN 3 — THE COMMENT, and it is a WRITE (owner spec,
                      2026-09-29).

                      First press records the comment and the order becomes
                      `Commented`; later presses arrive populated and save as an
                      edit, so there is one row per order however often it is
                      commented on.

                      OFFERED ON A HANDLED ORDER TOO (ops, 2026-10-04:
                      *"Handled orders should also have the Comment button so
                      the agent can edit the reason and action"*).

                      It used to disappear once a coupon was given, on the
                      reasoning that the coupon's own reason overrides the
                      comment and editing one nobody reads invites a
                      contradiction. In practice the reason and action recorded
                      WITH the coupon are exactly what gets typed in a hurry and
                      needs correcting afterwards — and with the button gone
                      there was no way to correct them at all.

                      Editing a handled row is SAFE because `decisionOutcome`
                      already guards it: an existing decision yields `'update'`,
                      which rewrites the wording and never converts a
                      compensation back into a comment. So this only ever edits
                      text; it cannot unmake a coupon.
                    */}
                          <Td>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => openDecision(row, 'commented', true)}
                            >
                              {stateOf(row.orderId) === 'pending'
                                ? t('lateOrders.comment', { defaultValue: 'Comment' })
                                : /* It is an EDIT once something is recorded, and
                                     saying so stops an agent fearing they are
                                     about to add a second, contradictory note. */
                                  t('lateOrders.editComment', { defaultValue: 'Edit' })}
                            </Button>
                          </Td>
                        </Tr>
                      </Fragment>
                    ))}
                  </tbody>
                </Table>
              </TableSurface>
              {/* Outside the surface, like the report tables: it belongs to the table
            rather than scrolling away inside it. */}
              <TablePager
                page={current}
                onPage={setPage}
                pageSize={pageSize}
                onPageSize={setPageSize}
                total={rows.length}
                pageSizes={LATE_ORDER_PAGE_SIZES}
                labels={{
                  rowsPerPage: String(
                    t('lateOrders.rowsPerPage', { defaultValue: 'Rows per page' }),
                  ),
                  previous: String(
                    t('actions.previous', { ns: 'common', defaultValue: 'Previous' }),
                  ),
                  next: String(t('actions.next', { ns: 'common', defaultValue: 'Next' })),
                  showing: ({ from: f, to: tTo, total }) =>
                    String(
                      t('lateOrders.showingRange', {
                        defaultValue: 'Showing {{from}}-{{to}} of {{total}}',
                        from: f,
                        to: tTo,
                        total,
                      }),
                    ),
                }}
              />
            </>
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
                draft.action === 'commented'
                  ? editingDecisionId
                    ? t('lateOrders.commentEditTitle', { defaultValue: 'Edit the comment' })
                    : t('lateOrders.commentTitle', { defaultValue: 'Comment on this order' })
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
                      {/* REQUIRED, and said so rather than discovered by pressing
                          a button that does nothing. */}
                      <span aria-hidden className="ms-1 text-destructive">
                        *
                      </span>
                    </span>
                    <Textarea
                      autoFocus
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={t('lateOrders.reasonPlaceholder', {
                        defaultValue: 'The reason - or type / for a ready one.',
                      })}
                    />
                    {/*
                      READY REASONS, THE SAME "/" THE COMPOSER USES (ops,
                      2026-10-04: *"/ opening instant replies for late orders
                      reason is not implemented"*).

                      The same component and the same library the inbox uses,
                      not a second one: agents already know the gesture, and two
                      implementations of "ready text" would drift. Typing `/`
                      opens the list and filters it; a pick REPLACES the box,
                      because a reason is one statement rather than a sentence
                      being assembled.

                      `{order}` and `{restaurant}` are filled from the row, so a
                      template reads as a real reason rather than a form with
                      holes in it.
                    */}
                    <QuickReplies
                      className="pt-1"
                      kind="late_order_reason"
                      dismissSearchOnOutside
                      customerText=""
                      query={reasonSlash}
                      searching={reasonSearching}
                      vars={{
                        order: draft.row.orderId,
                        brand: draft.row.brandName ?? null,
                        restaurant: draft.row.restaurantName ?? null,
                      }}
                      onPick={setReason}
                    />
                  </label>
                  {/*
                A FRESH COMMENT NEEDS ONLY THE REASON (owner, 2026-09-28: "no
                need action. just reason is enough").

                Writing the comment IS the act, so asking what was done about it
                invites an empty box or a restatement of the line above. Shown
                when COMPENSATING, where something was actually done, and shown
                when EDITING, so a line already written can be corrected rather
                than stranded.
              */}
                  {(draft.action === 'compensated' || !!editingDecisionId) && (
                    <label className="block space-y-1">
                      <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {t('lateOrders.actionLabel', { defaultValue: 'Action taken' })}
                        {/* MANDATORY WHEN A COUPON IS BEING ASSIGNED (ops,
                            2026-10-04). A compensation whose action nobody wrote
                            is a row the register cannot explain. */}
                        <span aria-hidden className="ms-1 text-destructive">
                          *
                        </span>
                      </span>
                      <Textarea
                        rows={2}
                        value={actionTaken}
                        onChange={(e) => setActionTaken(e.target.value)}
                        placeholder={t('lateOrders.actionPlaceholder', {
                          defaultValue: 'What you did - or type / for a ready one.',
                        })}
                      />
                      {/*
                        READY ACTIONS — its OWN library (ops, 2026-10-04:
                        *"the quick reply feature in reason box... should also
                        be implemented for action taken. the values in reason
                        and action taken are new and isolated from each other
                        and the inbox quick replies"*).

                        Three separate sets, because they answer three different
                        questions: a chat reply is addressed to a CUSTOMER, a
                        reason explains why an order was late, an action says
                        what was done about it. Pooling them would offer an
                        agent mostly wrong answers in all three places, which is
                        how a convenience becomes a thing people scroll past.
                      */}
                      <QuickReplies
                        className="pt-1"
                        kind="late_order_action"
                        dismissSearchOnOutside
                        customerText=""
                        query={actionSlash}
                        searching={actionSearching}
                        vars={{
                          order: draft.row.orderId,
                          brand: draft.row.brandName ?? null,
                          restaurant: draft.row.restaurantName ?? null,
                        }}
                        onPick={setActionTaken}
                      />
                    </label>
                  )}
                  {/* Said BEFORE deciding, because filing a complaint against a
                  branch is not something to discover afterwards. Driven by the
                  cause's GROUP, so a cause operations add tomorrow announces
                  itself without anyone editing this. */}
                  {causeRaisesTicket(
                    causes.data?.find((c) => c.value === kindOf(draft.row))?.group ??
                      DEFAULT_LATE_ORDER_CAUSES.find((c) => c.value === kindOf(draft.row))?.group,
                  ) && (
                    <p className="rounded-lg bg-secondary/50 px-3 py-2 text-xs leading-relaxed">
                      {t('lateOrders.willRaiseTicket', {
                        type: lateOrderComplaintType(kindOf(draft.row)),
                        defaultValue: 'A "{{type}}" ticket will be raised for this order.',
                      })}
                    </p>
                  )}
                </div>
              }
              confirmLabel={
                /* SAVE for a comment, first one or an edit — it is the same act and
               the same record either way (owner, 2026-09-29: "the button must
               read save"). */
                draft.action === 'commented'
                  ? t('actions.save', { ns: 'common', defaultValue: 'Save' })
                  : t('lateOrders.confirmCoupon', { defaultValue: 'Continue to coupon' })
              }
              cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
              loading={busy}
              /*
               * REFUSED, AND IT SAYS WHY (ops, 2026-10-04).
               *
               * The press used to be swallowed silently when the reason was
               * empty — indistinguishable from a dead button, which is the
               * single most-reported shape in this app. Now the button is
               * visibly disabled and the hint names the field that is missing.
               */
              confirmDisabled={!canCommitDecision}
              confirmHint={
                !reason.trim()
                  ? t('lateOrders.reasonRequired', { defaultValue: 'A reason is required.' })
                  : t('lateOrders.actionRequired', {
                      defaultValue: 'Say what you did about it.',
                    })
              }
              onConfirm={() => {
                /* The reason is required in EVERY case: a comment is a recorded
               state, so there is no longer a read-only path that may save
               nothing. */
                if (!canCommitDecision) return;
                void commit();
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
        flow behind it.

        THE TICKET, WHEN THERE IS ONE (owner, 2026-09-28). This was hardcoded
        `null` on the reasoning that "a late order has an order and no complaint
        behind it" — true when it was written, and stale since late_preparation
        began raising a ticket of its own. So a coupon raised from a late
        PREPARATION had a ticket sitting right beside it and stored no link to
        it: the row appeared in Compensation and in neither ticket report, and
        nothing tied the money to the complaint it answered.

        Still null for a late DELIVERY, which genuinely has no ticket — see the
        note where the ticket is raised. `couponOrderId` prefers the ticket's
        order anyway, so the two can never name different orders.
      */}
          {coupon && (
            <CouponRequestDialog
              open
              onClose={() => setCoupon(null)}
              ticketId={coupon.ticketId}
              orderId={coupon.row.orderId}
              contactId={coupon.contactId}
              /* NORMALISED, not Yiji's wire format. Yiji sends `+9665XXXXXXXX`;
             every phone this CRM stores and displays is `05XXXXXXXX` (owner's
             call, 2026-08-24). The ticket path already passes a normalised
             contact phone — this one passed the raw value straight through, so
             a late-order coupon reached the approvals queue titled
             `+966545808075` (owner, 2026-09-28). */
              customerPhone={normalizePhone(coupon.row.customerPhone) || null}
              /* THE ORDER'S OWN LINES, sku included — the same shape the tickets
             page passes. Falls back to the cart (no sku, `item_sku` then stays
             null rather than being invented from a name) when the order cannot
             be read, so the dropdown never ends up emptier than before. */
              orderItems={
                couponOrder.data?.items?.length
                  ? couponOrder.data.items.map((it) => ({
                      name: it.name,
                      price: it.price ?? null,
                      /* The QUANTITY travels with the price, because `price` is the
                     price of ONE — without it the picker summed a 3× line as a
                     single item and under-filled the coupon (owner,
                     2026-09-29). */
                      qty: it.qty ?? null,
                      sku: it.sku ?? null,
                    }))
                  : (couponCart.data?.lines ?? []).map((l) => ({
                      name: l.name,
                      price: l.price ?? null,
                      qty: l.qty ?? null,
                      sku: null,
                    }))
              }
              description={coupon.reason}
              /*
               * THE BRAND, in YIJI'S OWN NAME — the same thing the tickets page
               * passes (owner, 2026-09-28: a late order must carry every piece of
               * information a chat does).
               *
               * This was hardcoded `null`, so a late-order coupon reached the
               * approvals queue with no brand at all while one raised from a ticket
               * carried it. Yiji cannot resolve our internal ids, and for one brand
               * the names differ — we say "Casa Pasta" where they say "La Casa
               * Pasta" — so the store master's `brandYijiName` is what travels,
               * falling back to our display name, which is at least something a
               * human can act on.
               */
              brandId={couponStore?.store?.brandYijiName?.trim() || coupon.row.brandName || null}
              /* Yiji's restaurant id from the STORE MASTER when the branch is
             matched, else the one the order carried. */
              restaurantId={couponStore?.store?.yijiRestaurantId || coupon.row.restaurantId || null}
              brandName={couponStore?.brandName ?? coupon.row.brandName ?? null}
              branchName={couponStore?.restaurantName ?? coupon.row.restaurantName ?? null}
              requestedBy={user?.id ?? null}
              onCreated={() => {
                /*
                 * The coupon EXISTS now, so the decision is true and can be
                 * written — and only now is the ticket raised. If this fails the
                 * order stays in the queue with a coupon already requested —
                 * visible and fixable, unlike a register that claims a
                 * compensation nobody sent.
                 *
                 * The TICKET FIRST, then the decision that points at it: a decision
                 * naming a ticket that was never created would be worse than one
                 * naming none. A ticket that cannot be raised (no branch in the
                 * store master) is reported and the decision is still recorded —
                 * the coupon is real either way, and losing the record of it to a
                 * store-master gap would be the wrong trade.
                 */
                void (async () => {
                  let ticketId: string | null = null;
                  try {
                    ticketId = (await coupon.raiseTicket?.()) ?? null;
                  } catch (err) {
                    toast.warning(
                      err instanceof Error
                        ? err.message
                        : t('lateOrders.ticketFailed', {
                            defaultValue:
                              'The coupon was requested, but no ticket could be raised.',
                          }),
                    );
                  }
                  /* The order as it stood when the coupon was given. Best-effort,
                 like the ticket above: the decision is the record, and losing
                 it because Yiji was slow would be the wrong trade. */
                  const orderSnapshot = (await coupon.captureOrder?.()) ?? null;
                  return record.mutateAsync({
                    row: coupon.row,
                    kind: coupon.kind,
                    action: 'compensated',
                    reason: coupon.reason,
                    actionTaken: coupon.actionTaken,
                    agentId: user?.id ?? null,
                    ticketId,
                    orderSnapshot,
                  });
                })().catch(() =>
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
      </div>
    </div>
  );
}
