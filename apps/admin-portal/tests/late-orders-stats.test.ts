import { describe, expect, it } from 'vitest';
import {
  latestPerOrder,
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
        row({ action: 'commented', kind: 'late_preparation', minutes_elapsed: 80 }),
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
      /* WAITING time, not order age: 60/80/100 elapsed against a 60 threshold
         is 0/20/40 on the queue, so 20. The old reading averaged the elapsed
         values themselves and returned 80. */
      avgMinutes: 20,
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
    // 90 elapsed - 60 threshold = 30 minutes on the queue.
    expect(s!.avgMinutes).toBe(30);
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

/*
 * WAITING TIME, MEASURED FROM WHEN THE ORDER APPEARED (owner, 2026-09-29).
 *
 * An order only reaches the late-orders page once it passes the threshold, so
 * "how long did the agent leave it" is `minutes_elapsed - threshold`. The old
 * figure was time since the customer ordered, which described the kitchen and
 * the driver rather than the agent: on production every value sat just above
 * 60 (63, 62, 65, 75) and moved barely at all. Subtracting the threshold turns
 * the same rows into 3, 2, 5, 15.
 */
describe('avgMinutes is time spent waiting on the queue', () => {
  it('subtracts the threshold it was given', () => {
    const [s] = agentLateStats([row({ minutes_elapsed: 75 })], UNKNOWN, 60);
    expect(s!.avgMinutes).toBe(15);
  });

  /* The threshold is an EDITABLE setting, so the figure has to follow it.
     Hardcoding 60 would misreport every row the day operations change it. */
  it('follows a changed threshold', () => {
    const [s] = agentLateStats([row({ minutes_elapsed: 75 })], UNKNOWN, 45);
    expect(s!.avgMinutes).toBe(30);
  });

  it('defaults to 60 when no threshold is passed', () => {
    const [s] = agentLateStats([row({ minutes_elapsed: 75 })], UNKNOWN);
    expect(s!.avgMinutes).toBe(15);
  });

  /* Never negative: a clock disagreement between Yiji and us must not produce
     an agent who answered before the order was there to answer. */
  it('clamps at zero rather than reporting a negative wait', () => {
    const [s] = agentLateStats([row({ minutes_elapsed: 40 })], UNKNOWN, 60);
    expect(s!.avgMinutes).toBe(0);
  });

  it('averages the waits, not the elapsed values', () => {
    const [s] = agentLateStats(
      [row({ minutes_elapsed: 63 }), row({ minutes_elapsed: 75 })],
      UNKNOWN,
      60,
    );
    // (3 + 15) / 2 = 9 — the old reading would have said 69.
    expect(s!.avgMinutes).toBe(9);
  });
});

/*
 * ONE ROW PER ORDER IN THE REGISTER (owner, 2026-09-29).
 *
 * A re-decision writes a NEW row, so an agent who ignores an order and then
 * compensates it leaves two. Orders 1323103 and 1323132 each showed a
 * superseded `late_delivery/ignored` beside the `late_preparation/compensated`
 * that replaced it, and every count through the report was doubled for them.
 *
 * The agent portal already collapsed this way — which is exactly why the two
 * screens disagreed.
 */
describe('latestPerOrder', () => {
  it('keeps the newest decision and drops the superseded one', () => {
    const newest = row({ order_id: '1323103', kind: 'late_preparation', action: 'compensated' });
    const older = row({ order_id: '1323103', kind: 'late_delivery', action: 'commented' });
    // Rows arrive sorted -date_created, so the newest is first.
    const out = latestPerOrder([newest, older]);
    expect(out).toHaveLength(1);
    expect(out[0]!.action).toBe('compensated');
    expect(out[0]!.kind).toBe('late_preparation');
  });

  it('leaves orders with a single decision alone', () => {
    const out = latestPerOrder([row({ order_id: 'a' }), row({ order_id: 'b' })]);
    expect(out).toHaveLength(2);
  });

  it('collapses several orders independently', () => {
    const out = latestPerOrder([
      row({ order_id: 'a', action: 'compensated' }),
      row({ order_id: 'b', action: 'compensated' }),
      row({ order_id: 'a', action: 'commented' }),
      row({ order_id: 'b', action: 'commented' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.action === 'compensated')).toBe(true);
  });

  /* A row with no order id cannot be deduplicated against anything. Dropping
     it would silently discard work somebody did. */
  it('keeps every row that has no order id', () => {
    const out = latestPerOrder([
      row({ order_id: null }),
      row({ order_id: null }),
      row({ order_id: '  ' }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('returns an empty list unchanged', () => {
    expect(latestPerOrder([])).toEqual([]);
  });
});
