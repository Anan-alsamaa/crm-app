import { describe, it, expect } from 'vitest';
import { PerformanceQuery, readPerformanceDataset } from '../src/performance-report.js';

/**
 * Agent performance is read by the gateway with its service token (owner,
 * 2026-10-11): a WeCare Agent who picks another agent sees that agent's data.
 * The client names a dataset and filters; the server decides every field.
 */
function recorder(rows: unknown[] = [{ id: 'r' }]) {
  const calls: Array<{ collection: string; query: Record<string, unknown> }> = [];
  const read = async (collection: string, query: Record<string, unknown>) => {
    calls.push({ collection, query });
    return rows;
  };
  return { calls, read };
}
const q = (v: unknown) => PerformanceQuery.parse(v);

describe('performance report datasets', () => {
  it('chats in range for the chosen agent, with no vendor clause unless one is chosen', async () => {
    const r = recorder();
    await readPerformanceDataset(
      r.read,
      q({ dataset: 'conversations', filters: { from: '2026-10-01', agentId: 'ali' } }),
    );
    expect(r.calls[0]!.collection).toBe('conversations');
    expect(r.calls[0]!.query['filter']).toEqual({
      _and: [{ date_created: { _gte: '2026-10-01' } }, { assigned_agent: { _eq: 'ali' } }],
    });
  });

  it('scopes chats, tickets and coupons to a chosen vendor', async () => {
    for (const dataset of ['conversations', 'tickets', 'coupons'] as const) {
      const r = recorder();
      await readPerformanceDataset(
        r.read,
        q({ dataset, filters: { from: '2026-10-01', vendor: 'v-two' } }),
      );
      expect(JSON.stringify(r.calls[0]!.query['filter'])).toContain('{"vendor":{"_eq":"v-two"}}');
    }
  });

  it('never returns message text - who wrote and when only', async () => {
    const r = recorder();
    await readPerformanceDataset(r.read, q({ dataset: 'messages', ids: ['c1'] }));
    expect(r.calls[0]!.query['fields']).toEqual([
      'conversation',
      'sender_type',
      'date_created',
      'sender_user',
    ]);
    expect(r.calls[0]!.query['filter']).toEqual({
      conversation: { _in: ['c1'] },
      is_internal_note: { _eq: false },
    });
  });

  it('reads ratings by chat for the rating column', async () => {
    const r = recorder();
    await readPerformanceDataset(r.read, q({ dataset: 'csat', ids: ['c1', 'c2'] }));
    expect(r.calls[0]!.collection).toBe('csat_responses');
    expect(r.calls[0]!.query['filter']).toEqual({ conversation: { _in: ['c1', 'c2'] } });
  });

  it('chunks long id lists so no request URL grows unbounded', async () => {
    const r = recorder([]);
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    await readPerformanceDataset(r.read, q({ dataset: 'routingEvents', ids }));
    expect(r.calls).toHaveLength(3);
  });

  it('refuses unknown datasets and fields the client invents', () => {
    expect(PerformanceQuery.safeParse({ dataset: 'directus_users' }).success).toBe(false);
    expect(
      PerformanceQuery.safeParse({ dataset: 'couponExtra', field: 'yiji_admin_password' }).success,
    ).toBe(false);
  });
});
