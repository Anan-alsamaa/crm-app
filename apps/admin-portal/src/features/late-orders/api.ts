import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import {
  DEFAULT_LATE_DELIVERY_MINUTES,
  LATE_DELIVERY_MINUTES_KEY,
  lateDeliveryMinutes,
  mergeLateOrders,
  type LateOrderRow,
  type LateOrderDecisionRow,
  type LateOrderRegisterRow,
  type LateOrderSnapshot,
  type LateOrderState,
  type YijiOrder,
} from '@yiji/shared-types';

/* Re-exported so the admin pages and tests that already import these from here
   keep working, and so there is still one obvious place to look. */
export {
  mergeLateOrders,
  type LateOrderDecisionRow,
  type LateOrderRegisterRow,
  type LateOrderSnapshot,
};
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';

/**
 * The late-order register: every decision an agent recorded from the queue.
 *
 * Read from `late_order_decisions`, which is append-only — the row is the
 * record of a judgement somebody made, so it is never rewritten and never
 * pruned by the feature that writes it.
 */

/* The register's shape and its merge now live in `@yiji/shared-types`, beside
   `lateOrderState` — both portals show this register and a second copy is how
   they drift. Re-exported below so this module stays the one import site for
   the admin pages that already use it. */

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

/**
 * THE ORDER BEHIND A ROW THAT HAS NO SNAPSHOT.
 *
 * A PENDING late order has never been decided, so nothing was ever captured —
 * the Order button opened a dialog that could only say "nothing was recorded"
 * (owner, 2026-10-03: it should show the order for pending rows too).
 *
 * A decided row keeps using its SNAPSHOT, deliberately. That is the order as it
 * stood when the agent judged it, and Yiji keeps mutating an order afterwards:
 * asking them again months later answers a different question. Only a row with
 * nothing captured falls through to this live read.
 *
 * One order, only while its dialog is open — never a column, never a page of
 * them. That is the difference between one call and hundreds.
 */
export function useLiveOrder(vendorId: string | undefined, orderId: string | null | undefined) {
  return useQuery<YijiOrder | null>({
    queryKey: ['late-order-live', vendorId ?? '', orderId ?? ''],
    enabled: !!vendorId && !!orderId,
    /* An order that has already happened does not change while a dialog is
       open, so this is cached long enough to survive reopening it. */
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => commerce.getOrder(vendorId!, orderId!),
  });
}

/** One order line as the panel shows it: what one costs, and what the line cost. */
export interface SnapshotLine {
  name: string;
  qty: number;
  unit: number;
  lineTotal: number;
  sku: string | null;
  category: string | null;
}

/**
 * The snapshot's items, priced per LINE.
 *
 * `price` in a snapshot is Yiji's `itemPrice` — the price of ONE. Rendering it
 * raw is the money bug the owner caught on the coupon form (2026-09-29): three
 * waters at 1 SAR read as "1" while the inbox, which multiplies, read 3. The
 * same field is stored here, so the same rule applies, and it lives in one
 * exported function so the report and its tests cannot disagree.
 *
 * A missing or non-positive quantity counts as ONE and a missing price as zero:
 * both appear on real Yiji lines, and a line silently worth nothing is how a
 * plausible wrong total gets read as fact.
 */
export function snapshotLines(snap: LateOrderSnapshot | null | undefined): SnapshotLine[] {
  return (snap?.items ?? []).map((it) => {
    const qty = typeof it.qty === 'number' && it.qty > 0 ? it.qty : 1;
    const unit = typeof it.price === 'number' && it.price > 0 ? it.price : 0;
    return {
      name: it.name?.trim() || '—',
      qty,
      unit,
      lineTotal: unit * qty,
      sku: it.sku?.trim() || null,
      category: it.category?.trim() || null,
    };
  });
}

/** What the lines add up to — shown beside the order's own stored total. */
export function snapshotLinesTotal(lines: readonly SnapshotLine[]): number {
  return lines.reduce((sum, l) => sum + l.lineTotal, 0);
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
              /* The stored order. One more JSON column on a query already being
                 made — and it is what makes the register's order panel cost no
                 Yiji calls at all. */
              'order_snapshot',
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
