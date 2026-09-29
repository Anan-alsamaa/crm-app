import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import {
  DEFAULT_LATE_DELIVERY_MINUTES,
  LATE_DELIVERY_MINUTES_KEY,
  lateDeliveryMinutes,
  lateOrderState,
  type LateOrderKind,
  type LateOrderRow,
  type LateOrderState,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';

/**
 * The late-order register: every decision an agent recorded from the queue.
 *
 * Read from `late_order_decisions`, which is append-only — the row is the
 * record of a judgement somebody made, so it is never rewritten and never
 * pruned by the feature that writes it.
 */

export interface LateOrderDecisionRow {
  id: string;
  order_id: string | null;
  kind: LateOrderKind | null;
  action: 'commented' | 'compensated' | null;
  reason: string | null;
  /**
   * What the agent DID about it — the Comments box's second field.
   *
   * OPTIONAL, because every decision recorded before 2026-09-27 predates the
   * field and genuinely has nothing to show. A required type here would be a
   * claim the data does not support.
   */
  action_taken?: string | null;
  minutes_elapsed: number | null;
  brand_name: string | null;
  restaurant_name: string | null;
  date_created: string | null;
  decided_by: { id: string; first_name: string | null; last_name: string | null } | null;
  ticket: { id: string } | null;
}

/**
 * A late order as the register shows it: decided or not.
 *
 * A PENDING late order has NO DATABASE ROW — it exists only in Yiji's queue
 * until somebody comments on it or gives a coupon (owner, 2026-09-29). So the
 * register is a MERGE of two sources, and a row can come from either.
 */
export interface LateOrderRegisterRow extends Omit<LateOrderDecisionRow, 'id'> {
  /** The decision's id, or a synthetic one for a queue-only row. */
  id: string;
  /** pending | commented | handled — never the ORDER's own status. */
  state: LateOrderState;
  /** The order's own status from Yiji — a different thing entirely. */
  order_status?: string | null;
  customer_phone?: string | null;
  /** True when nothing has been recorded: the row is queue-only. */
  pendingOnly: boolean;
}

/**
 * Merge the live queue with what has been decided.
 *
 * DECISIONS WIN. An order that has been commented on or compensated is
 * described by its decision; the queue only supplies the orders nobody has
 * touched. Merged on `orderId`, the one identifier both sides share.
 *
 * The queue is the source for a pending row's branch, brand, phone and ORDER
 * STATUS — which is not the handling state and must never be confused with it.
 *
 * Exported so the tests exercise the real rule.
 */
export function mergeLateOrders(
  decisions: readonly LateOrderDecisionRow[],
  queue: readonly LateOrderRow[],
): LateOrderRegisterRow[] {
  const decided = new Set<string>();
  const out: LateOrderRegisterRow[] = [];

  for (const d of decisions) {
    const key = d.order_id?.trim();
    if (key) decided.add(key);
    out.push({ ...d, state: lateOrderState(d), pendingOnly: false });
  }

  for (const q of queue) {
    const key = q.orderId?.trim();
    /* Already answered for. The decision describes it, not the queue. */
    if (!key || decided.has(key)) continue;
    out.push({
      /* Synthetic and PREFIXED, so it can never collide with a decision's uuid
         and so anything keying off it is obviously not a decision. */
      id: `pending:${key}`,
      order_id: key,
      /* Unclassified until somebody says otherwise — the cause is a judgement
         an agent makes, not something the queue knows. */
      kind: null,
      action: null,
      reason: null,
      action_taken: null,
      minutes_elapsed: q.minutesElapsed ?? null,
      brand_name: q.brandName ?? null,
      restaurant_name: q.restaurantName ?? null,
      /* The ORDER's creation time. A pending row has no decision, so there is
         no decision time to show — and dating it "now" would put every pending
         order at the top of a report sorted by when things happened. */
      date_created: q.placedAt ?? null,
      decided_by: null,
      ticket: null,
      state: 'pending',
      order_status: q.status ?? null,
      customer_phone: q.customerPhone ?? null,
      pendingOnly: true,
    });
  }

  /* Newest first, like the decisions query — one ordering for the whole
     register rather than decisions first and pending appended. */
  return out.sort((a, b) => (b.date_created ?? '').localeCompare(a.date_created ?? ''));
}

/**
 * One row per order: the LATEST decision, newest first.
 *
 * A re-decision writes a NEW row — an agent who ignores an order and then
 * compensates it leaves two — and the register listed both, so orders 1323103
 * and 1323132 each showed a superseded `late_delivery/ignored` beside the
 * `late_preparation/compensated` that replaced it (owner, 2026-09-29). Every
 * count through the report was doubled for those orders.
 *
 * The AGENT PORTAL already collapsed this way, which is why the two screens
 * disagreed and why the agent's view looked correct while the report did not.
 *
 * NOTHING IS DELETED. A superseded decision stays in the database and in the
 * audit trail; it simply is not what the order currently IS.
 *
 * EXPORTED so the tests exercise the real function rather than a restatement
 * of it that would pass whatever the hook does. Expects rows already sorted
 * `-date_created`, which is how they are queried.
 */
/**
 * The live queue for the same window the register covers.
 *
 * Its own query, deliberately: it can fail on its own — Yiji is an external
 * dependency — and a register that showed nothing because the queue timed out
 * would be worse than one showing every decision and saying the pending rows
 * are missing. `retry: false` for the same reason: three silent retries leave a
 * spinner where an answer should be.
 */
export function useLateOrderQueue(fromIso: string, toIso: string) {
  return useQuery({
    queryKey: ['late-order-queue', fromIso, toIso],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<LateOrderRow[]> => {
      const q = await commerce.getLateOrders({
        from: fromIso.slice(0, 10),
        to: toIso.slice(0, 10),
      });
      return q?.rows ?? [];
    },
  });
}

/**
 * Event times for the rows CURRENTLY ON SCREEN.
 *
 * The gateway caps a batch at 50 and each id costs a call into Yiji's production
 * API upstream, so this is deliberately given the visible PAGE rather than the
 * whole window: a register covering a month can hold thousands of rows, and
 * asking for all of them would be thousands of calls for columns nobody has
 * scrolled to.
 *
 * `retry: false` and a shared failure: Yiji is external, and three silent
 * retries leave a skeleton where an answer should be. A failure blanks these
 * four columns and nothing else — every other column comes from our own
 * database.
 */
export function useLateOrderEventTimes(orderIds: string[]) {
  // Sorted + joined so the key is stable: the same ids in a different order
  // must not look like a different query and refetch.
  const key = [...orderIds].sort().join(',');
  return useQuery<Record<string, Record<string, string | null>>>({
    queryKey: ['late-order-event-times', key],
    enabled: orderIds.length > 0,
    staleTime: 60_000,
    retry: false,
    queryFn: () => commerce.getOrderEventTimes(orderIds),
  });
}

export function latestPerOrder(rows: LateOrderDecisionRow[]): LateOrderDecisionRow[] {
  const seen = new Set<string>();
  const out: LateOrderDecisionRow[] = [];
  for (const r of rows) {
    const key = r.order_id?.trim();
    /* A row with no order id cannot be deduplicated against anything — keep it
       rather than silently dropping work somebody did. */
    if (!key) {
      out.push(r);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function useLateOrderDecisions(fromIso: string, toIso: string) {
  return useQuery({
    queryKey: ['late-order-decisions', fromIso, toIso],
    queryFn: async (): Promise<LateOrderDecisionRow[]> =>
      (await directus.request(
        readItems(
          'late_order_decisions' as never,
          {
            filter: { date_created: { _between: [fromIso, toIso] } },
            fields: [
              'id',
              'order_id',
              'kind',
              'action',
              'reason',
              'action_taken',
              'minutes_elapsed',
              'brand_name',
              'restaurant_name',
              'date_created',
              { decided_by: ['id', 'first_name', 'last_name'] },
              { ticket: ['id'] },
            ],
            sort: ['-date_created'],
            limit: -1,
          } as never,
        ),
      )) as unknown as LateOrderDecisionRow[],
    /*
     * ONE ROW PER ORDER — THE LATEST DECISION (owner, 2026-09-29).
     *
     * A re-decision writes a NEW row: an agent who ignores an order and then
     * compensates it leaves two, and the register listed both. Orders 1323103
     * and 1323132 each showed a superseded `late_delivery/ignored` beside the
     * `late_preparation/compensated` that replaced it, so the report read as
     * duplicated and every count through it was doubled.
     *
     * The AGENT PORTAL already collapsed to the newest per order — which is
     * why the two screens disagreed, and why the agent's view looked right
     * while the report did not. This makes the report agree with it.
     *
     * The rows are sorted `-date_created`, so the FIRST seen for an order is
     * its latest. Nothing is deleted: a superseded decision is still in the
     * database and still in the audit trail; it simply is not what the order
     * currently IS.
     */
    select: latestPerOrder,
  });
}

/** The agent's display name, or a named gap rather than a blank cell. */
export function agentName(row: LateOrderDecisionRow, unknown: string): string {
  const u = row.decided_by;
  if (!u) return unknown;
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || unknown;
}

/**
 * The live threshold, from `app_settings`.
 *
 * READ, not assumed: it is editable, and the waiting-time figure is
 * `elapsed - threshold`, so a stale 60 here would misreport every row the day
 * operations change it. `lateDeliveryMinutes` is total — a missing row, a typo
 * or a wild number all resolve to the documented default rather than throwing
 * or producing a negative wait.
 */
export function useLateOrderThreshold() {
  return useQuery({
    queryKey: ['late-order-threshold'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<number> => {
      const rows = (await directus.request(
        readItems(
          'app_settings' as never,
          {
            filter: { key: { _eq: LATE_DELIVERY_MINUTES_KEY } },
            fields: ['value'],
            limit: 1,
          } as never,
        ),
      )) as unknown as Array<{ value: string | null }>;
      return lateDeliveryMinutes(rows[0]?.value);
    },
  });
}

export interface AgentLateStats {
  agent: string;
  /** Every late order this agent acted on — commented or compensated. */
  touched: number;
  compensated: number;
  /** Explained but not compensated. Was `ignored` before that state existed. */
  commented: number;
  latePreparation: number;
  lateDelivery: number;
  /**
   * Mean minutes the order sat ON THE QUEUE before the agent decided.
   *
   * Measured from when it BECAME VISIBLE, not from when the customer placed it
   * (owner, 2026-09-29). An order only reaches this page once it passes the
   * threshold, so the waiting figure is `minutes_elapsed - threshold`.
   *
   * The old reading — time since placement — described how late the ORDERS
   * were, which is a fact about the kitchen and the driver. Every value sat
   * just above 60 and moved barely at all: 63, 62, 65, 75. Subtracting the
   * threshold turns the same data into 3, 2, 5, 15 — how long an agent left it
   * sitting, which is the thing an agent KPI is asking about.
   *
   * Never negative: a clock disagreement must not produce an agent who
   * answered before the order was there to answer.
   */
  avgMinutes: number | null;
}

/**
 * Per-agent totals.
 *
 * Counts only — deliberately no "compensation rate" or league position. The
 * right number of coupons to give depends on what actually went wrong, and a
 * rate on a dashboard becomes a target that rewards giving away money or
 * refusing to.
 */
export function agentLateStats(
  rows: readonly (LateOrderDecisionRow & { state?: LateOrderState })[],
  unknown: string,
  /**
   * The threshold the rows were selected by, subtracted to get waiting time.
   *
   * PASSED IN, not hardcoded: it is an editable setting (`late_delivery_minutes`
   * in `app_settings`, 60 today), and baking 60 in here would silently
   * misreport every figure the day somebody changes it.
   */
  thresholdMinutes: number = DEFAULT_LATE_DELIVERY_MINUTES,
): AgentLateStats[] {
  const by = new Map<string, AgentLateStats & { _minutes: number[] }>();
  for (const r of rows) {
    /*
     * PENDING ROWS ARE NOT AGENT WORK, and must not enter this table.
     *
     * Since the register merges the live queue in (owner spec §11), most rows in
     * a fresh window have no decision and no agent. Counting them would add a
     * large "Unassigned" line to a table whose entire subject is what each agent
     * DID, and inflate the team total with orders nobody has touched.
     *
     * Keyed on the absence of an `action` rather than on `state`, so a caller
     * passing plain decision rows — which have no `state` — behaves exactly as
     * before.
     */
    if (r.state === 'pending' || !r.action) continue;
    const agent = agentName(r, unknown);
    let s = by.get(agent);
    if (!s) {
      s = {
        agent,
        touched: 0,
        compensated: 0,
        commented: 0,
        latePreparation: 0,
        lateDelivery: 0,
        avgMinutes: null,
        _minutes: [],
      };
      by.set(agent, s);
    }
    s.touched += 1;
    if (r.action === 'compensated') s.compensated += 1;
    if (r.action === 'commented') s.commented += 1;
    if (r.kind === 'late_preparation') s.latePreparation += 1;
    if (r.kind === 'late_delivery') s.lateDelivery += 1;
    if (typeof r.minutes_elapsed === 'number') {
      // Clamped at 0 — see the note on `avgMinutes`.
      s._minutes.push(Math.max(0, r.minutes_elapsed - thresholdMinutes));
    }
  }
  return [...by.values()]
    .map(({ _minutes, ...s }) => ({
      ...s,
      avgMinutes: _minutes.length
        ? Math.round(_minutes.reduce((a, b) => a + b, 0) / _minutes.length)
        : null,
    }))
    .sort((a, b) => b.touched - a.touched);
}
