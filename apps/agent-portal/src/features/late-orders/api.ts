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
 * Late orders that have been HANDLED — compensated, nothing less.
 *
 * Yiji has no idea we have handled anything: the order stays live and keeps
 * coming back from `GetFilteredOrders` until it completes. Without this the
 * agent would face the same rows every thirty seconds with no sign of the work
 * they just did.
 *
 * **`action: 'compensated'`, and that filter is the whole point.** This used to
 * return every order carrying ANY decision row, which was right while the two
 * decisions were "compensate" and "ignore" — both were final. Under the state
 * model the owner specified (2026-09-29) a COMMENT is a recorded state that is
 * explicitly *not* handling, so an unfiltered set would mark a commented order
 * Handled, take its Assign coupon button away and collapse
 * `Pending → Commented → Handled` into two states. See [[silent-empty-failures]]
 * for this shape: the query still returns rows, so nothing looks broken.
 *
 * Keyed on the ORDER id rather than a row id because that is the only
 * identifier the two sides share.
 */
export function useHandledLateOrders() {
  return useQuery({
    queryKey: ['late-orders', 'handled'],
    staleTime: 15_000,
    queryFn: async (): Promise<Set<string>> => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows = (await directus.request(
        readItems(
          'late_order_decisions' as never,
          {
            filter: {
              date_created: { _gte: since },
              action: { _eq: 'compensated' },
            },
            fields: ['order_id'],
            limit: -1,
          } as never,
        ),
      )) as unknown as Array<{ order_id: string | null }>;
      return new Set(rows.map((r) => r.order_id?.trim()).filter((v): v is string => !!v));
    },
  });
}

/**
 * The decision already recorded for each order, so Comments can show and edit
 * it rather than starting blank.
 *
 * Keyed by order id — the only identifier the CRM and Yiji share. Returns the
 * NEWEST row per order: the decision is append-only for its type, but the two
 * free-text fields are editable, and an older row would show stale wording.
 */
export function useLateOrderDecisions() {
  return useQuery({
    queryKey: ['late-orders', 'decisions'],
    staleTime: 15_000,
    queryFn: async (): Promise<Map<string, LateOrderDecisionRow>> => {
      const rows = (await directus.request(
        readItems(
          'late_order_decisions' as never,
          {
            filter: {
              date_created: { _gte: new Date(Date.now() - 30 * 86_400_000).toISOString() },
            },
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
       * BOTH queries, or the row does not go away.
       *
       * The queue hides a decided order by checking it against the HANDLED set
       * (`useHandledLateOrders`), which is a separate query. Invalidating only
       * the queue refetched the same rows from Yiji — who has no idea we
       * decided anything — and compared them against a stale handled set, so
       * an ignored order sat there until the 15s staleTime lapsed and looked
       * like the button had done nothing (owner, 2026-09-27).
       */
      void qc.invalidateQueries({ queryKey: ['late-orders'] });
      void qc.invalidateQueries({ queryKey: ['late-orders', 'handled'] });
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
