import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems } from '@directus/sdk';
import {
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
export function useLateOrders(range?: { from: string; to: string }, enabled = true) {
  /*
   * A RANGE stops the polling.
   *
   * The live queue is about right-now and refreshes every 30s. A historical
   * window is a fixed set of finished orders — re-fetching it on a timer would
   * be three upstream pages bought for an answer that cannot change, and it
   * would yank the table under someone reading it.
   */
  const history = !!range;
  return useQuery<LateOrderQueue>({
    queryKey: [...LATE_ORDERS_KEY, range?.from ?? 'today', range?.to ?? 'today'],
    queryFn: () => commerce.getLateOrders(range),
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

export interface RecordLateDecisionInput {
  row: LateOrderRow;
  kind: LateOrderKind;
  action: 'ignored' | 'compensated';
  reason: string;
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
            decided_by: input.agentId,
            ticket: input.ticketId ?? null,
            minutes_elapsed: input.row.minutesElapsed,
            brand_name: input.row.brandName ?? null,
            restaurant_name: input.row.restaurantName ?? null,
          } as never,
        ),
      ),
    onSuccess: () => {
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
  kind: LateOrderKind;
  reason: string;
  contactId: string | null;
  vendorId: string | null;
  agentId: string | null;
}): Record<string, unknown> {
  const complaintType = LATE_ORDER_COMPLAINT_TYPE[opts.kind];
  return {
    subject: complaintType,
    description: opts.reason.trim(),
    priority: 'medium',
    contact: opts.contactId,
    vendor: opts.vendorId,
    assigned_agent: opts.agentId,
    customer_phone: opts.row.customerPhone ?? null,
    complaint_date: new Date().toISOString(),
    complaint_type: complaintType,
    // Fixed by the owner's spec: these orders are delivery, by definition —
    // the queue only ever asks Yiji for `DeliveryTypeIds=1`.
    service_type: 'Delivery',
    complaint_source: DEFAULT_COMPLAINT_SOURCE,
    communication_method: DEFAULT_COMPLAINT_SOURCE,
    order_id: opts.row.orderId,
    status: 'open',
  };
}

export const FALLBACK_THRESHOLD = DEFAULT_LATE_DELIVERY_MINUTES;
