import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import {
  DEFAULT_LATE_DELIVERY_MINUTES,
  LATE_DELIVERY_MINUTES_KEY,
  lateDeliveryMinutes,
  type LateOrderKind,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

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
  action: 'ignored' | 'compensated' | null;
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
  handled: number;
  compensated: number;
  ignored: number;
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
  rows: readonly LateOrderDecisionRow[],
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
    const agent = agentName(r, unknown);
    let s = by.get(agent);
    if (!s) {
      s = {
        agent,
        handled: 0,
        compensated: 0,
        ignored: 0,
        latePreparation: 0,
        lateDelivery: 0,
        avgMinutes: null,
        _minutes: [],
      };
      by.set(agent, s);
    }
    s.handled += 1;
    if (r.action === 'compensated') s.compensated += 1;
    if (r.action === 'ignored') s.ignored += 1;
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
    .sort((a, b) => b.handled - a.handled);
}
