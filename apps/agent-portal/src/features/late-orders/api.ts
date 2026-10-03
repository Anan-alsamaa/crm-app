import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems, updateItem } from '@directus/sdk';
import {
  normalizePhone,
  toStoreSnapshot,
  type StoreMatch,
  DEFAULT_LATE_DELIVERY_MINUTES,
  lateOrderComplaintType,
  DEFAULT_COMPLAINT_SOURCE,
  type LateOrderQueue,
  type LateOrderRow,
  DEFAULT_LATE_ORDER_CAUSES,
  LATE_ORDER_CAUSE_LIST,
  type LateOrderGroup,
  type LateOrderSnapshot,
} from '@yiji/shared-types';
import { commerce } from '../../lib/commerce-client.js';
import { directus } from '../../lib/directus.js';

/**
 * Late Delivery Handling — the agent's queue and the two decisions.
 *
 * See docs/LATE-DELIVERY.md for the measured facts about the Yiji endpoints
 * behind this; the surprising ones are load-bearing.
 */

export const LATE_ORDERS_KEY = ['late-orders'] as const;

/**
 * The queue.
 *
 * The threshold arrives WITH the rows rather than being asked for separately,
 * so the screen can never state a rule different from the one the rows were
 * selected by.
 */
export function useLateOrders(
  range?: { from: string; to: string },
  enabled = true,
  /**
   * TODAY IS A RANGE THAT STILL MOVES.
   *
   * Today loads the current business day as a range so finished orders stay on
   * the list, but it is not history: new orders cross the threshold while an
   * agent watches it, and a day that stopped updating at the moment it was
   * opened would be a queue nobody can work from. So the caller says whether
   * this range is the live day, and polling follows that rather than the mere
   * presence of dates.
   */
  live = false,
) {
  /*
   * A PAST RANGE stops the polling.
   *
   * The live queue is about right-now and refreshes every 30s. A historical
   * window is a fixed set of finished orders — re-fetching it on a timer would
   * be three upstream pages bought for an answer that cannot change, and it
   * would yank the table under someone reading it.
   */
  const history = !!range && !live;
  return useQuery<LateOrderQueue>({
    queryKey: [
      ...LATE_ORDERS_KEY,
      range?.from ?? 'today',
      range?.to ?? 'today',
      /* Part of the key: Today and a hand-picked range covering the same dates
         are different questions with different freshness, and a React Query key
         must contain everything its data resolved against. */
      live ? 'live' : 'hist',
    ],
    queryFn: () => commerce.getLateOrders(range, live),
    enabled,
    refetchInterval: history ? false : 30_000,
    staleTime: history ? 5 * 60_000 : 15_000,
    retry: false,
  });
}

/**
 * The decision already recorded for each order, so Comments can show and edit
 * it rather than starting blank.
 *
 * Keyed by order id — the only identifier the CRM and Yiji share. Returns the
 * NEWEST row per order: the decision is append-only for its type, but the two
 * free-text fields are editable, and an older row would show stale wording.
 *
 * BOUNDED BY THE RANGE THE AGENT ASKED FOR, not by a fixed window.
 *
 * This used to take a hardcoded last-30-days. Creation time, business day,
 * agent, reason and action taken all come from here, so searching anything
 * older showed a row with five empty columns — and because the screen also
 * rebuilds aged-out orders FROM these rows, an older search lost them
 * altogether (ops, 2026-10-03). The admin register bounds the same query by the
 * selected range; now both do.
 *
 * `to` is EXCLUSIVE of the next day's start, which is what `businessDayRange`
 * already returns, so a decision taken at 03:00 belongs to the night that is
 * still running rather than to the morning after.
 */
export function useLateOrderDecisions(range?: { from: string; to: string }) {
  return useQuery({
    /* The range is IN THE KEY. Without it a search for last week would be
       served the cached answer for today and quietly show the wrong rows. */
    queryKey: ['late-orders', 'decisions', range?.from ?? null, range?.to ?? null],
    staleTime: 15_000,
    queryFn: async (): Promise<Map<string, LateOrderDecisionRow>> => {
      const rows = (await directus.request(
        readItems(
          'late_order_decisions' as never,
          {
            filter: range
              ? { date_created: { _between: [`${range.from}T00:00:00`, `${range.to}T00:00:00`] } }
              : /* No range means "today", which the caller resolves; a bare 30
                   days is kept only as the floor for that case so the first
                   paint is not unbounded. */
                { date_created: { _gte: new Date(Date.now() - 30 * 86_400_000).toISOString() } },
            /* `date_created` and `decided_by` so the queue can show WHEN a
               decision was taken and by WHOM — the register in the admin
               portal reports both, and the two screens must agree. */
            fields: [
              'id',
              'order_id',
              'action',
              'kind',
              'reason',
              'action_taken',
              'ticket',
              'date_created',
              /*
               * WHAT A DECIDED ORDER IS REBUILT FROM once Yiji's live queue has
               * dropped it (ops, 2026-10-03: no data for yesterday).
               *
               * The queue answers only with orders currently past the
               * threshold, so this screen used to lose its own history. These
               * four are everything `decidedOrdersAsQueueRows` needs to put
               * such an order back on the list — the snapshot carries when it
               * was placed, its status and the customer, and the decision
               * itself carries how late it was and where it came from.
               */
              'minutes_elapsed',
              'brand_name',
              'restaurant_name',
              'order_snapshot',
              { decided_by: ['id', 'first_name'] },
            ],
            sort: ['-date_created'],
            limit: -1,
          } as never,
        ),
      )) as unknown as LateOrderDecisionRow[];
      const byOrder = new Map<string, LateOrderDecisionRow>();
      // Newest first, so the first one seen for an order wins.
      for (const r of rows) {
        const key = r.order_id?.trim();
        if (key && !byOrder.has(key)) byOrder.set(key, r);
      }
      return byOrder;
    },
  });
}

export interface LateOrderDecisionRow {
  id: string;
  order_id: string | null;
  action: string | null;
  kind: string | null;
  reason: string | null;
  action_taken: string | null;
  /** When the decision was taken — the register's "Creation time". */
  date_created?: string | null;
  /** Who took it. Expanded so the queue can name them without a second read. */
  decided_by?: { id: string; first_name: string | null } | null;
  /**
   * The ticket this decision raised, when it raised one.
   *
   * Read so a SECOND decision on the same order can reuse it rather than
   * raising another — four tickets appeared for order 1323291 because an agent
   * submitted four decisions minutes apart (owner, 2026-09-28).
   */
  ticket: string | null;
  /* The four below exist so a decided order can be put back on the queue when
     Yiji no longer returns it — see the field list above. */
  minutes_elapsed?: number | null;
  brand_name?: string | null;
  restaurant_name?: string | null;
  order_snapshot?: LateOrderSnapshot | null;
}

/**
 * Correct the wording on a decision already recorded.
 *
 * Only the two free-text fields: the decision TYPE stays as it was taken. An
 * agent fixing a typo must not be able to turn an ignore into a compensation.
 */
export function useUpdateLateDecision() {
  const qc = useQueryClient();
  return useMutation({
    /*
     * PARTIAL by design. The comment dialog sends the two free-text fields; the
     * Source of delay dropdown sends `kind` alone and must not blank the reason
     * somebody already wrote. So each field is sent only when it was supplied,
     * rather than spreading an object with `undefined` holes that Directus would
     * happily write as nulls.
     */
    mutationFn: (input: { id: string; reason?: string; actionTaken?: string; kind?: string }) => {
      const patch: Record<string, string | null> = {};
      if (input.reason !== undefined) patch.reason = input.reason.trim();
      if (input.actionTaken !== undefined) patch.action_taken = input.actionTaken.trim() || null;
      if (input.kind !== undefined) patch.kind = input.kind;
      return directus.request(
        updateItem('late_order_decisions' as never, input.id, patch as never),
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['late-orders'] });
    },
  });
}

/**
 * SERVICE TIME for the rows on screen: driver-accept → close, or → now.
 *
 * Only the visible order ids, because the driver-accept moment is not in the
 * late-orders list — it lives in each order's status history, one call each.
 * Asking for a 600-row queue would be 600 calls into Yiji's production API per
 * page load; asking for the ~25 a human can see is one batched call.
 *
 * Returns `orderId -> { status: timestamp }` — the whole status history,
 * flattened. The DURATIONS are computed at render by `orderEventTimes`, against
 * the same clock the rest of the row uses, so a live order's service time ticks.
 */
export function useOrderEventTimes(orderIds: string[]) {
  // Sorted + joined so the key is stable: the same ids in a different order
  // must not look like a different query and refetch.
  const key = [...orderIds].sort().join(',');
  return useQuery<Record<string, Record<string, string | null>>>({
    queryKey: ['late-orders', 'event-times', key],
    enabled: orderIds.length > 0,
    staleTime: 60_000,
    retry: false,
    queryFn: () => commerce.getOrderEventTimes(orderIds),
  });
}

/**
 * The contact behind a late order, when the CRM already knows them.
 *
 * The owner's spec says the ticket carries the CONTACT from the order. We were
 * passing `null`, so a late-preparation ticket named nobody: the branch got a
 * complaint with no customer attached, and it could not be found by searching
 * the number that raised it.
 *
 * LOOKUP ONLY — it never creates a contact (owner, 2026-09-22). A late order
 * is an operational event, not a reason to put somebody in the customer
 * directory: most of these orders end fine, and minting a contact for every
 * one would fill the directory with people who never contacted us. When the
 * customer is already known the ticket links to them; when they are not, the
 * ticket carries the order and the phone and that is enough.
 *
 * MATCHED ON THE STORED FORM. Yiji sends `+9665XXXXXXXX`; this CRM stores
 * `05XXXXXXXX` and nothing else. Searching with Yiji's shape would match
 * nothing and silently report every customer as unknown.
 *
 * Returns null rather than throwing: a ticket with no contact is worse than
 * one with, but losing the whole decision over a lookup would be the wrong
 * trade.
 */
export async function resolveLateOrderContact(
  row: LateOrderRow,
  vendorId: string | null,
): Promise<string | null> {
  const phone = normalizePhone(row.customerPhone);
  if (!phone || !vendorId) return null;
  try {
    const existing = (await directus.request(
      readItems(
        'contacts' as never,
        {
          filter: { vendor: { _eq: vendorId }, phone: { _eq: phone } },
          fields: ['id'],
          limit: 1,
        } as never,
      ),
    )) as unknown as Array<{ id: string }>;
    return existing[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The causes an agent may choose, WITH the group that decides the pipeline.
 *
 * Its own hook rather than `useOptionLists`, which flattens every list to bare
 * values — the group is the whole point here, and a shared hook that dropped it
 * would make the pipeline unknowable at the call site.
 *
 * FALLS BACK to the two seeded causes when the list cannot be read. An empty
 * dropdown would leave an agent unable to decide anything at all, and these two
 * are what the code shipped with.
 */
export interface LateOrderCause {
  value: string;
  group: LateOrderGroup;
}

export function useLateOrderCauses() {
  return useQuery({
    queryKey: ['late-order-causes'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<LateOrderCause[]> => {
      const rows = (await directus.request(
        readItems(
          'option_lists' as never,
          {
            limit: -1,
            filter: { list: { _eq: LATE_ORDER_CAUSE_LIST }, active: { _eq: true } },
            sort: ['sort', 'value'],
            fields: ['value', 'group'],
          } as never,
        ),
      )) as unknown as Array<{ value: string; group: string | null }>;
      if (rows.length === 0) return [...DEFAULT_LATE_ORDER_CAUSES];
      return rows.map((r) => ({
        value: r.value,
        /* `wecare` for anything unrecognised — the quieter outcome. A row with a
           missing or mistyped group must not start filing complaints against
           branches on its own. */
        group: r.group === 'operations' ? 'operations' : 'wecare',
      }));
    },
  });
}

export interface RecordLateDecisionInput {
  row: LateOrderRow;
  /**
   * The cause, as a STRING.
   *
   * It was `LateOrderKind` — a two-value union — which stopped compiling the
   * moment causes became an editable list (owner, 2026-09-29). The seeded two
   * are still the only ones most deployments will see, but the type can no
   * longer promise that: operations add their own, and the value stored is
   * whatever they typed.
   */
  kind: string;
  action: 'commented' | 'compensated';
  reason: string;
  /** What the agent DID about it, free text. Optional. */
  actionTaken?: string;
  agentId: string | null;
  /** The ticket raised alongside, when one was. */
  ticketId?: string | null;
  /**
   * The ORDER as it stood when this was decided — items, totals, payment and
   * delivery (owner, 2026-09-29).
   *
   * FROZEN, like `store_snapshot` on a ticket and for the same reason: an order
   * edited or refunded upstream must not rewrite what the agent actually saw
   * and decided against.
   *
   * Fetched ONLY on a decision. The queue can hold hundreds of rows and only a
   * handful are ever decided; fetching per row would be hundreds of calls into
   * Yiji's production API on every page load.
   */
  orderSnapshot?: unknown;
}

/**
 * Record what was decided about a late order.
 *
 * Written for BOTH outcomes, including Ignore. An ignored order is a decision
 * somebody made — the reason is the whole point of asking for one, and a
 * queue that forgets what it was told to ignore is a queue that asks again
 * tomorrow.
 */
export function useRecordLateDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordLateDecisionInput) =>
      directus.request(
        createItem(
          'late_order_decisions' as never,
          {
            order_id: input.row.orderId,
            kind: input.kind,
            action: input.action,
            reason: input.reason.trim(),
            action_taken: input.actionTaken?.trim() || null,
            decided_by: input.agentId,
            ticket: input.ticketId ?? null,
            minutes_elapsed: input.row.minutesElapsed,
            order_snapshot: input.orderSnapshot ?? null,
            brand_name: input.row.brandName ?? null,
            restaurant_name: input.row.restaurantName ?? null,
          } as never,
        ),
      ),
    onSuccess: () => {
      /*
       * ONE INVALIDATION, AND IT COVERS EVERYTHING.
       *
       * `['late-orders']` is a PREFIX in React Query, so it already takes the
       * queue, the decisions and the event times with it. There used to be a
       * second, explicit invalidation of `['late-orders','handled']` because
       * the page hid a decided order by checking a separate 24-hour HANDLED
       * set, and refetching the queue alone left that set stale — a decided
       * order sat there until the 15s staleTime lapsed and the button looked
       * dead (owner, 2026-09-27).
       *
       * That set is gone (ops, 2026-10-03): its 24-hour window meant an order
       * compensated the day before read as unhandled, and the page now answers
       * the question from the decisions it already holds.
       */
      void qc.invalidateQueries({ queryKey: ['late-orders'] });
    },
  });
}

/**
 * The ticket a late order raises, with the defaults the owner specified.
 *
 * `complaint_type` comes from the shared map so the stored spelling is
 * operations' own — "Instore preparation late order", displayed as "Late
 * preparation in store". Both values already exist in the live option list, so
 * this needs no data change.
 */
export function lateOrderTicket(opts: {
  row: LateOrderRow;
  /**
   * The cause, as a STRING.
   *
   * It was `LateOrderKind` — a two-value union — which stopped compiling the
   * moment causes became an editable list (owner, 2026-09-29). The seeded two
   * are still the only ones most deployments will see, but the type can no
   * longer promise that: operations add their own, and the value stored is
   * whatever they typed.
   */
  kind: string;
  reason: string;
  contactId: string | null;
  vendorId: string | null;
  agentId: string | null;
  /**
   * The branch this order belongs to, resolved from the store master.
   *
   * WITHOUT IT THE TICKET IS INVISIBLE. The operations report shows COMPLETE
   * rows only, and `restaurantName` is one of the fields it requires — so a
   * ticket with no branch is filtered out silently and reads as "the ticket
   * was never created". Measured: order 1280043 raised ticket bc7dac2d on
   * 2026-09-28, which existed in the database and never appeared in the
   * breakdown (owner, 2026-09-28).
   *
   * The late-order row carries the branch (`restaurantId`, `restaurantName`,
   * `brandName`), so there was never a reason not to resolve it.
   */
  storeMatch?: StoreMatch | null;
}): Record<string, unknown> {
  const complaintType = lateOrderComplaintType(opts.kind);
  return {
    subject: complaintType,
    description: opts.reason.trim(),
    priority: 'medium',
    contact: opts.contactId,
    vendor: opts.vendorId,
    assigned_agent: opts.agentId,
    /*
     * THE CUSTOMER, in this CRM's own shape.
     *
     * Yiji sends `+9665XXXXXXXX`; every phone stored here is `05XXXXXXXX`.
     * Writing Yiji's form onto the ticket would make it the one record an
     * agent cannot find by typing the number the way they always type it, and
     * would put a fourth shape back into a column that was deliberately
     * collapsed to one.
     *
     * This is how the customer reaches the ticket when they are NOT already a
     * contact — the lookup returns null then, and the phone is all there is.
     */
    customer_phone: normalizePhone(opts.row.customerPhone) || null,
    complaint_date: new Date().toISOString(),
    complaint_type: complaintType,
    // Fixed by the owner's spec: these orders are delivery, by definition —
    // the queue only ever asks Yiji for `DeliveryTypeIds=1`.
    service_type: 'Delivery',
    complaint_source: DEFAULT_COMPLAINT_SOURCE,
    communication_method: DEFAULT_COMPLAINT_SOURCE,
    order_id: opts.row.orderId,
    // The branch, live — what reports group by — and the frozen copy, so a
    // later edit to the store master cannot rewrite this ticket's history.
    // Both from the SAME match, so they can never name different branches.
    store: opts.storeMatch?.store?.id ?? null,
    store_snapshot: opts.storeMatch
      ? toStoreSnapshot(opts.storeMatch, new Date().toISOString())
      : null,
    /*
     * SOLVED ON ARRIVAL (owner, 2026-09-29).
     *
     * This ticket is not work waiting to be done: by the time it exists the
     * agent has already classified the delay and either compensated or ignored
     * it. Filed as `open` it sat in every agent's queue as an outstanding job
     * nobody could action, and the real work was over before it was written.
     *
     * `solved`, not "closed" — the vocabulary here is open / pending / solved
     * and inventing a fourth value would break every status filter, chart and
     * export that reads it.
     *
     * WHAT MARKS IT AS A LATE ORDER is `complaint_type`, carried above and used
     * as the subject too: "Late order" or "Instore preparation late order".
     * Both are existing values in the live option lists, so the reports group
     * them without any new vocabulary.
     */
    status: 'solved',
  };
}

export const FALLBACK_THRESHOLD = DEFAULT_LATE_DELIVERY_MINUTES;
