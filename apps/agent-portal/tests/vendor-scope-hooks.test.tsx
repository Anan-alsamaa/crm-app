import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';

/*
 * MV-7: the reads behind the inbox tiles, Agent performance and the late-orders
 * queue follow a chosen vendor. Unset — always, with one vendor — every request
 * is byte-identical to before: no vendor clause, no `vendorId` param.
 */

const db = vi.hoisted(() => ({
  calls: [] as Array<{ collection: string; query: Record<string, unknown> }>,
}));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, query: Record<string, unknown> = {}) => ({ collection, query }),
  createItem: vi.fn(),
  updateItem: vi.fn(),
}));
vi.mock('../src/lib/directus.js', () => ({
  directus: {
    request: vi.fn(async (req: { collection: string; query: Record<string, unknown> }) => {
      db.calls.push(req);
      if (req.query?.aggregate) return [{ count: { id: 0 } }];
      if (req.collection === 'conversations') return [{ id: 'c1', status: 'open' }];
      if (req.collection === 'tickets') return [{ id: 't1' }];
      if (req.collection === 'coupon_approvals') return [{ id: 'cp1' }];
      return [];
    }),
  },
}));
const commerce = vi.hoisted(() => ({
  getLateOrders: vi.fn(async () => ({ rows: [], thresholdMinutes: 60, builtAt: '' })),
  getOrderEventTimes: vi.fn(async () => ({})),
}));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce }));

import { useInboxCounts } from '../src/features/inbox/api.js';
import {
  useChatTimings,
  useCouponPerformance,
  useTicketPerformance,
} from '../src/features/performance/api.js';
import {
  useLateOrderDecisions,
  useLateOrders,
  useOrderEventTimes,
} from '../src/features/late-orders/api.js';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const callsTo = (collection: string) => db.calls.filter((c) => c.collection === collection);
const json = (v: unknown) => JSON.stringify(v ?? null);

beforeEach(() => {
  db.calls = [];
  commerce.getLateOrders.mockClear();
  commerce.getOrderEventTimes.mockClear();
});

describe('inbox count tiles', () => {
  it('count every vendor, with no vendor clause, when none is chosen', async () => {
    renderHook(() => useInboxCounts({ assignment: 'all' }), { wrapper: wrapper() });
    await waitFor(() => expect(callsTo('conversations')).toHaveLength(3));
    for (const c of callsTo('conversations')) expect(json(c.query.filter)).not.toContain('vendor');
  });

  it("count only the chosen vendor's chats", async () => {
    renderHook(() => useInboxCounts({ assignment: 'all', vendor: 'v-two' }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(callsTo('conversations')).toHaveLength(3));
    for (const c of callsTo('conversations'))
      expect(json(c.query.filter)).toContain('"vendor":{"_eq":"v-two"}');
  });

  /* The inbox page passes the SAME vendor its list is filtered by — which is
     undefined unless 2+ vendors are active and one is chosen. */
  it('the inbox feeds its vendor filter to the tile counts', () => {
    const page = readFileSync(resolve(__dirname, '../src/pages/Inbox.tsx'), 'utf8');
    expect(page).toMatch(/useInboxCounts\(\{[^}]*vendor: vendorFilter,?\s*\}\)/);
  });
});

describe('Agent performance reads', () => {
  const run = async (vendor?: string) => {
    const filters = { from: '2026-10-01', agentId: 'faisal', ...(vendor ? { vendor } : {}) };
    const w = wrapper();
    renderHook(() => useChatTimings(filters), { wrapper: w });
    renderHook(() => useTicketPerformance(filters), { wrapper: w });
    renderHook(() => useCouponPerformance(filters), { wrapper: w });
    await waitFor(() => {
      expect(callsTo('conversations').length).toBeGreaterThan(0);
      expect(callsTo('tickets').length).toBeGreaterThan(0);
      // The main coupon read plus its four best-effort field reads.
      expect(callsTo('coupon_approvals').length).toBeGreaterThanOrEqual(5);
    });
  };

  it('add no vendor clause when none is chosen', async () => {
    await run();
    const conv = callsTo('conversations')[0]!;
    expect(conv.query.filter).toEqual({
      _and: [{ date_created: { _gte: '2026-10-01' } }, { assigned_agent: { _eq: 'faisal' } }],
    });
    const tickets = callsTo('tickets').filter((c) => json(c.query.filter).includes('date_created'));
    for (const c of tickets) expect(json(c.query.filter)).not.toContain('vendor');
    const coupons = callsTo('coupon_approvals').filter((c) =>
      json(c.query.filter).includes('date_created'),
    );
    expect(coupons.length).toBeGreaterThanOrEqual(5);
    for (const c of coupons) expect(json(c.query.filter)).not.toContain('vendor');
  });

  it('scope chats, tickets and coupons (and their KPIs) to the chosen vendor', async () => {
    await run('v-two');
    expect(callsTo('conversations')[0]!.query.filter).toEqual({
      _and: [
        { date_created: { _gte: '2026-10-01' } },
        { assigned_agent: { _eq: 'faisal' } },
        { vendor: { _eq: 'v-two' } },
      ],
    });
    const tickets = callsTo('tickets').filter((c) => json(c.query.filter).includes('date_created'));
    expect(tickets).toHaveLength(1);
    expect(json(tickets[0]!.query.filter)).toContain('{"vendor":{"_eq":"v-two"}}');
    const coupons = callsTo('coupon_approvals').filter((c) =>
      json(c.query.filter).includes('date_created'),
    );
    expect(coupons.length).toBeGreaterThanOrEqual(5);
    for (const c of coupons) expect(json(c.query.filter)).toContain('{"vendor":{"_eq":"v-two"}}');
  });
});

describe('late-orders queue', () => {
  const range = { from: '2026-10-08', to: '2026-10-09' };

  it('asks the gateway exactly as before with no vendor chosen', async () => {
    const w = wrapper();
    renderHook(() => useLateOrders(range, true, true), { wrapper: w });
    renderHook(() => useOrderEventTimes(['111']), { wrapper: w });
    renderHook(() => useLateOrderDecisions(range), { wrapper: w });
    await waitFor(() => expect(commerce.getLateOrders).toHaveBeenCalled());
    await waitFor(() => expect(commerce.getOrderEventTimes).toHaveBeenCalled());
    await waitFor(() => expect(callsTo('late_order_decisions')).toHaveLength(1));
    // Not even a trailing `undefined`.
    expect(commerce.getLateOrders.mock.calls[0]).toEqual([range, true]);
    expect(commerce.getOrderEventTimes.mock.calls[0]).toEqual([['111']]);
    expect(callsTo('late_order_decisions')[0]!.query.filter).toEqual({
      date_created: { _between: ['2026-10-08T00:00:00', '2026-10-10T00:00:00'] },
    });
  });

  it("passes the chosen vendor's CRM id to the gateway and the decisions", async () => {
    const w = wrapper();
    renderHook(() => useLateOrders(range, true, true, 'v-two'), { wrapper: w });
    renderHook(() => useOrderEventTimes(['111'], 'v-two'), { wrapper: w });
    renderHook(() => useLateOrderDecisions(range, 'v-two'), { wrapper: w });
    await waitFor(() => expect(commerce.getLateOrders).toHaveBeenCalled());
    await waitFor(() => expect(commerce.getOrderEventTimes).toHaveBeenCalled());
    await waitFor(() => expect(callsTo('late_order_decisions')).toHaveLength(1));
    expect(commerce.getLateOrders.mock.calls[0]).toEqual([range, true, 'v-two']);
    expect(commerce.getOrderEventTimes.mock.calls[0]).toEqual([['111'], 'v-two']);
    expect(callsTo('late_order_decisions')[0]!.query.filter).toEqual({
      _and: [
        { date_created: { _between: ['2026-10-08T00:00:00', '2026-10-10T00:00:00'] } },
        { vendor: { _eq: 'v-two' } },
      ],
    });
  });

  /* The page is too large to mount here; these pin its wiring. */
  it('the page offers the filter only with 2+ vendors and feeds it to every read', () => {
    const page = readFileSync(
      resolve(__dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/vendorDir\.show && vendorDir\.options\.some/);
    expect(page).toMatch(/\{vendorDir\.show && \(/);
    expect(page).toMatch(
      /useLateOrders\(activeRange, true, showingToday, vendorFilter \|\| undefined\)/,
    );
    expect(page).toMatch(
      /useLateOrderDecisions\(activeRange \?\? undefined, vendorFilter \|\| undefined\)/,
    );
    expect(page).toMatch(
      /useOrderEventTimes\(\s*paged\.map\(\(r\) => r\.orderId\),\s*vendorFilter \|\| undefined,?\s*\)/,
    );
  });
});
