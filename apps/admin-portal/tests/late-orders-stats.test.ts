import { describe, expect, it } from 'vitest';
import {
  agentLateStats,
  agentName,
  type LateOrderDecisionRow,
} from '../src/features/late-orders/api.js';

const UNKNOWN = 'Unassigned';

function row(over: Partial<LateOrderDecisionRow> = {}): LateOrderDecisionRow {
  return {
    id: Math.random().toString(36).slice(2),
    order_id: '1313926',
    kind: 'late_delivery',
    action: 'compensated',
    reason: 'driver reassigned',
    minutes_elapsed: 70,
    brand_name: 'Okashi',
    restaurant_name: 'Nada Plaza',
    date_created: '2026-09-21T14:00:00',
    decided_by: { id: 'u1', first_name: 'Ayman', last_name: null },
    ticket: null,
    ...over,
  };
}

describe('agentName', () => {
  it('joins the names it has', () => {
    expect(agentName(row(), UNKNOWN)).toBe('Ayman');
    expect(
      agentName(row({ decided_by: { id: 'u', first_name: 'A', last_name: 'B' } }), UNKNOWN),
    ).toBe('A B');
  });

  /*
   * A deleted user leaves `decided_by` null (SET NULL on the relation). A blank
   * cell there would read as "nobody decided this", which is a different and
   * false claim — the decision happened, the person is gone.
   */
  it('names the gap rather than leaving it blank', () => {
    expect(agentName(row({ decided_by: null }), UNKNOWN)).toBe(UNKNOWN);
    expect(
      agentName(row({ decided_by: { id: 'u', first_name: null, last_name: null } }), UNKNOWN),
    ).toBe(UNKNOWN);
  });
});

describe('agentLateStats', () => {
  it('counts each outcome and cause per agent', () => {
    const [ayman] = agentLateStats(
      [
        row({ action: 'compensated', kind: 'late_delivery', minutes_elapsed: 60 }),
        row({ action: 'ignored', kind: 'late_preparation', minutes_elapsed: 80 }),
        row({ action: 'compensated', kind: 'late_preparation', minutes_elapsed: 100 }),
      ],
      UNKNOWN,
    );
    expect(ayman).toMatchObject({
      agent: 'Ayman',
      handled: 3,
      compensated: 2,
      ignored: 1,
      latePreparation: 2,
      lateDelivery: 1,
      avgMinutes: 80,
    });
  });

  it('separates agents and ranks by how many each handled', () => {
    const stats = agentLateStats(
      [
        row({ decided_by: { id: 'a', first_name: 'Quiet', last_name: null } }),
        row({ decided_by: { id: 'b', first_name: 'Busy', last_name: null } }),
        row({ decided_by: { id: 'b', first_name: 'Busy', last_name: null } }),
      ],
      UNKNOWN,
    );
    expect(stats.map((s) => [s.agent, s.handled])).toEqual([
      ['Busy', 2],
      ['Quiet', 1],
    ]);
  });

  /* A row whose elapsed time was never recorded must not be averaged as zero —
   * that would drag the mean down and understate how late the work really was. */
  it('ignores missing minutes rather than counting them as nothing', () => {
    const [s] = agentLateStats(
      [row({ minutes_elapsed: 90 }), row({ minutes_elapsed: null })],
      UNKNOWN,
    );
    expect(s!.avgMinutes).toBe(90);
    expect(s!.handled).toBe(2);
  });

  it('reports no average at all when nothing was recorded', () => {
    const [s] = agentLateStats([row({ minutes_elapsed: null })], UNKNOWN);
    expect(s!.avgMinutes).toBeNull();
  });

  it('has nothing to say about an empty window', () => {
    expect(agentLateStats([], UNKNOWN)).toEqual([]);
  });
});
