import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import type { LateOrderKind } from '@yiji/shared-types';
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

export interface AgentLateStats {
  agent: string;
  handled: number;
  compensated: number;
  ignored: number;
  latePreparation: number;
  lateDelivery: number;
  /** Mean minutes past placement at the moment each was decided. */
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
    if (typeof r.minutes_elapsed === 'number') s._minutes.push(r.minutes_elapsed);
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
