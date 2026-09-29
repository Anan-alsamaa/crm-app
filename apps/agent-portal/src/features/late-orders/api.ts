import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems, updateItem } from '@directus/sdk';
import {
  normalizePhone,
  toStoreSnapshot,
  type StoreMatch,
  DEFAULT_LATE_DELIVERY_MINUTES,
  LATE_ORDER_COMPLAINT_TYPE,
  DEFAULT_COMPLAINT_SOURCE,
  type LateOrderKind,
  type LateOrderQueue,
  type LateOrderRow,
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
 * Late orders already decided, so the queue can hide them.
 *
 * Yiji has no idea we have handled anything — the order stays live and keeps
 * coming back from `GetFilteredOrders` until it completes. Without this the
 * agent would face the same rows every thirty seconds with no sign of the work
 * they just did.
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
            filter: { date_created: { _gte: since } },
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
            fields: ['id', 'order_id', 'action', 'kind', 'reason', 'action_taken', 'ticket'],
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
    mutationFn: (input: { id: string; reason: string; actionTaken: string }) =>
      directus.request(
        updateItem('late_order_decisions' as never, input.id, {
          reason: input.reason.trim(),
          action_taken: input.actionTaken.trim() || null,
        } as never),
      ),
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
 * Returns a map of order id → driver-accept timestamp (or null when the driver
 * has not accepted yet). The minutes are computed at render against the same
 * clock the rest of the row uses.
 */
export function useServiceTimes(orderIds: string[]) {
  // Sorted + joined so the key is stable: the same ids in a different order
  // must not look like a different query and refetch.
  const key = [...orderIds].sort().join(',');
  return useQuery<Record<string, string | null>>({
    queryKey: ['late-orders', 'service-times', key],
    enabled: orderIds.length > 0,
    staleTime: 60_000,
    retry: false,
    queryFn: () => commerce.getServiceTimes(orderIds),
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

export interface RecordLateDecisionInput {
  row: LateOrderRow;
  kind: LateOrderKind;
  action: 'ignored' | 'compensated';
  reason: string;
  /** What the agent DID about it, free text. Optional. */
  actionTaken?: string;
  agentId: string | null;
  /** The ticket raised alongside, when one was. */
  ticketId?: string | null;
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
  kind: LateOrderKind;
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
  const complaintType = LATE_ORDER_COMPLAINT_TYPE[opts.kind];
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
    status: 'open',
  };
}

export const FALLBACK_THRESHOLD = DEFAULT_LATE_DELIVERY_MINUTES;
