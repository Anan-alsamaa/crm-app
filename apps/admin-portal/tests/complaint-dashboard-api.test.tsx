import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

// Capture the QUERY each read is built with, not just its result — the date
// range is applied server-side, so the only way to prove it is to look at the
// filter we hand the SDK.
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readUsers: (opts: unknown) => ({ collection: 'directus_users', opts }),
  aggregate: (collection: string, opts: unknown) => ({ collection, opts, aggregate: true }),
}));

import {
  useComplaintMetrics,
  emptyComplaintFilters,
  type ComplaintFilters,
} from '../src/features/dashboard/complaints-api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const NOW = new Date('2026-07-15T12:00:00.000Z').getTime();
const iso = (d: string) => new Date(d).toISOString();

beforeEach(() => {
  request.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

/**
 * Queue the seven directus.request calls IN ORDER:
 * tickets, stores, users, csat, conversations, routing_events, message counts.
 * They are a positional Promise.all — adding a query to the hook without adding
 * it here silently shifts every later mock onto the wrong result.
 */
function mockData(opts: {
  tickets?: unknown[];
  stores?: unknown[];
  users?: unknown[];
  csat?: unknown[];
  conversations?: unknown[];
  routing?: unknown[];
  messages?: unknown[];
}) {
  request
    .mockResolvedValueOnce(opts.tickets ?? [])
    .mockResolvedValueOnce(opts.stores ?? [])
    .mockResolvedValueOnce(opts.users ?? [])
    .mockResolvedValueOnce(opts.csat ?? [])
    .mockResolvedValueOnce(opts.conversations ?? [])
    .mockResolvedValueOnce(opts.routing ?? [])
    .mockResolvedValueOnce(opts.messages ?? []);
}

const STORES = [
  {
    id: 'st1',
    code: 'LCP-002',
    name: 'Dhahran Mall',
    city: 'Khobar',
    area_manager: 'Aly',
    chain_manager: 'Ahmed',
    yiji_restaurant_id: null,
    brand: { id: 'br1', code: 'LCP', name: 'Casa Pasta' },
  },
  {
    id: 'st2',
    code: 'PSK-014',
    name: 'Doha Plaza',
    city: 'Dammam',
    area_manager: null,
    chain_manager: null,
    yiji_restaurant_id: null,
    brand: { id: 'br2', code: 'PSK', name: 'Pasketti' },
  },
];

const USERS = [{ id: 'u1', first_name: 'Amjad', last_name: null, email: 'a@x.com' }];

/** A complaint with sensible defaults; override what the test is about. */
function ticket(over: Record<string, unknown> = {}) {
  return {
    id: 't' + Math.random().toString(36).slice(2, 7),
    status: 'closed',
    date_created: iso('2026-07-01T09:00:00Z'),
    resolved_at: null,
    closed_at: iso('2026-07-01T15:00:00Z'),
    first_responded_at: iso('2026-07-01T09:30:00Z'),
    first_response_due_at: iso('2026-07-01T10:00:00Z'),
    assigned_agent: 'u1',
    conversation: null,
    store: 'st1',
    complaint_type: 'Missing item',
    service_type: 'Delivery',
    complaint_source: 'Comp. WhatsApp',
    compensation: 'Compensated',
    coupon_value: 10,
    contact: { phone: '0551141059' },
    order_snapshot: null,
    ...over,
  };
}

async function run(filters: ComplaintFilters = emptyComplaintFilters) {
  const { result } = renderHook(() => useComplaintMetrics(filters), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data!;
}

describe('complaint dashboard — compensation', () => {
  it('sums coupon_value into the headline compensation figure', async () => {
    mockData({
      tickets: [
        ticket({ coupon_value: 25 }),
        ticket({ coupon_value: 15 }),
        ticket({ coupon_value: null }),
      ],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    expect(d.total).toBe(3);
    expect(d.compensation).toBe(40);
    // Averaged over EVERY complaint, not just the compensated ones — that is
    // the "cost per complaint" the ops manager reads it as.
    expect(d.avgCompensation).toBeCloseTo(40 / 3);
  });

  it('splits compensation per month alongside the volume', async () => {
    mockData({
      tickets: [
        ticket({ date_created: iso('2026-05-04T09:00:00Z'), coupon_value: 10 }),
        ticket({ date_created: iso('2026-05-20T09:00:00Z'), coupon_value: 5 }),
        ticket({ date_created: iso('2026-06-02T09:00:00Z'), coupon_value: 100 }),
      ],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    expect(d.months.map((m) => m.month)).toEqual(['2026-05', '2026-06']);
    expect(d.months.map((m) => m.count)).toEqual([2, 1]);
    // June is the cheap month by volume and the expensive one by cost — the
    // whole reason the line is overlaid on the columns.
    expect(d.months.map((m) => m.compensation)).toEqual([15, 100]);
  });
});

describe('complaint dashboard — branch attribution', () => {
  it('prefers the branch the agent picked over the order snapshot', async () => {
    mockData({
      tickets: [
        ticket({
          store: 'st2',
          // A snapshot pointing at the OTHER branch must not win: someone chose
          // st2 by hand, and the order may not be what the complaint is about.
          order_snapshot: { restaurantName: 'Dhahran Mall', brandName: 'Casa Pasta' },
        }),
      ],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    expect(d.byRestaurant[0]?.label).toBe('PSK-014 Doha Plaza');
    expect(d.byCity[0]?.label).toBe('Dammam');
  });

  it('falls back to the order snapshot for tickets raised before the branch field existed', async () => {
    mockData({
      tickets: [
        ticket({
          store: null,
          order_snapshot: { restaurantName: 'Dhahran Mall', brandName: 'Casa Pasta' },
        }),
      ],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    expect(d.byRestaurant[0]?.label).toBe('LCP-002 Dhahran Mall');
    expect(d.unattributed).toBe(0);
  });

  it('counts a complaint with no branch at all rather than dropping it', async () => {
    mockData({
      tickets: [ticket({ store: null, order_snapshot: null }), ticket()],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    // Still in the total — a by-branch cut that silently shrinks the total is
    // how a dashboard lies.
    expect(d.total).toBe(2);
    expect(d.unattributed).toBe(1);
  });
});

describe('complaint dashboard — filters', () => {
  it('filters by brand, city and restaurant using the resolved branch', async () => {
    const tickets = [ticket({ store: 'st1' }), ticket({ store: 'st2' }), ticket({ store: 'st2' })];
    mockData({ tickets, stores: STORES, users: USERS });
    expect((await run({ ...emptyComplaintFilters, brand: 'br2' })).total).toBe(2);

    mockData({ tickets, stores: STORES, users: USERS });
    expect((await run({ ...emptyComplaintFilters, city: 'Khobar' })).total).toBe(1);

    mockData({ tickets, stores: STORES, users: USERS });
    expect((await run({ ...emptyComplaintFilters, store: 'st2' })).total).toBe(2);
  });

  it('sends an inclusive end date so a range ending today contains today', async () => {
    mockData({ tickets: [], stores: STORES, users: USERS });
    await run({ ...emptyComplaintFilters, from: '2026-01-01', to: '2026-07-31' });

    const ticketsQuery = request.mock.calls
      .map((c) => c[0] as { collection: string; opts: { filter?: Record<string, unknown> } })
      .find((q) => q.collection === 'tickets');
    expect(ticketsQuery?.opts.filter).toEqual({
      date_created: {
        _gte: '2026-01-01T00:00:00',
        // 23:59:59, not the bare date — `_lte: '2026-07-31'` would compare
        // against midnight and drop everything logged ON the last day.
        _lte: '2026-07-31T23:59:59',
      },
    });
  });

  it('sends no date filter at all when the range is left open', async () => {
    mockData({ tickets: [], stores: STORES, users: USERS });
    await run();
    const ticketsQuery = request.mock.calls
      .map((c) => c[0] as { collection: string; opts: { filter?: unknown } })
      .find((q) => q.collection === 'tickets');
    expect(ticketsQuery?.opts.filter).toBeUndefined();
  });
});

describe('complaint dashboard — status, satisfaction and agents', () => {
  it('counts open work and SLA-breached complaints separately', async () => {
    mockData({
      tickets: [
        ticket({ status: 'new' }),
        ticket({ status: 'pending' }),
        ticket({ status: 'closed' }),
        // Unanswered and past its due time — the "in trouble" signal that
        // stands in for his Escalated status.
        ticket({
          status: 'open',
          first_responded_at: null,
          first_response_due_at: iso('2026-07-14T09:00:00Z'),
        }),
      ],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    expect(d.open).toBe(3);
    expect(d.closed).toBe(1);
    expect(d.overdue).toBe(1);
  });

  it('rates satisfaction only over complaints whose chat was actually rated', async () => {
    mockData({
      tickets: [
        ticket({ status: 'closed', conversation: 'c1' }),
        ticket({ status: 'closed', conversation: 'c2' }),
        ticket({ status: 'closed', conversation: null }),
      ],
      stores: STORES,
      users: USERS,
      csat: [
        { id: 'r1', score: 5, conversation: 'c1' },
        { id: 'r2', score: 2, conversation: 'c2' },
      ],
    });
    const d = await run();
    expect(d.closed).toBe(3);
    // Denominator is the RATED ones, not all closed — and the page prints that
    // gap so 50% is not read as "half our customers are unhappy".
    expect(d.rated).toBe(2);
    expect(d.satisfied).toBe(1);
    expect(d.satisfiedPct).toBe(50);
  });

  it('reports null satisfaction rather than 0% when nothing was rated', async () => {
    mockData({ tickets: [ticket({ status: 'closed' })], stores: STORES, users: USERS });
    const d = await run();
    expect(d.satisfiedPct).toBeNull();
  });

  it('builds the agent table with solved rate, time to close and cost', async () => {
    mockData({
      tickets: [
        ticket({
          assigned_agent: 'u1',
          status: 'closed',
          date_created: iso('2026-07-01T00:00:00Z'),
          closed_at: iso('2026-07-01T04:00:00Z'),
          coupon_value: 30,
        }),
        ticket({ assigned_agent: 'u1', status: 'open', coupon_value: 0 }),
      ],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    const a = d.agents.find((x) => x.id === 'u1')!;
    expect(a.name).toBe('Amjad');
    expect(a.logged).toBe(2);
    expect(a.solved).toBe(1);
    expect(a.open).toBe(1);
    expect(a.solvedPct).toBe(50);
    expect(a.avgHoursToClose).toBe(4);
    expect(a.compensation).toBe(30);
  });

  it('keeps unassigned complaints visible instead of hiding them from the table', async () => {
    mockData({ tickets: [ticket({ assigned_agent: null })], stores: STORES, users: USERS });
    const d = await run();
    expect(d.agents.map((a) => a.name)).toContain('Unassigned');
  });
});

describe('complaint dashboard — breakdowns', () => {
  it('ranks each breakdown biggest first and ignores blanks', async () => {
    mockData({
      tickets: [
        ticket({ complaint_type: 'Late order', service_type: 'Delivery' }),
        ticket({ complaint_type: 'Late order', service_type: 'Delivery' }),
        ticket({ complaint_type: 'Missing item', service_type: null }),
      ],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    expect(d.byType.map((r) => [r.label, r.count])).toEqual([
      ['Late order', 2],
      ['Missing item', 1],
    ]);
    // The null service type is not a category called "".
    expect(d.byServiceType).toEqual([{ key: 'Delivery', label: 'Delivery', count: 2 }]);
  });

  it('offers filter options from the store master, not from what happens to have complaints', async () => {
    mockData({ tickets: [ticket({ store: 'st1' })], stores: STORES, users: USERS });
    const d = await run();
    // st2 has no complaints yet but must still be filterable — otherwise you
    // cannot ask "did this branch have any?".
    expect(d.storeOptions.map((s) => s.name)).toEqual([
      'LCP-002 Dhahran Mall',
      'PSK-014 Doha Plaza',
    ]);
    expect(d.brandOptions.map((b) => b.name)).toEqual(['Casa Pasta', 'Pasketti']);
    expect(d.cityOptions).toEqual(['Dammam', 'Khobar']);
  });
});

describe('complaint dashboard — the dimensions his dashboard slices by', () => {
  it('breaks down by area manager and by agent', async () => {
    mockData({
      tickets: [
        ticket({ store: 'st1', assigned_agent: 'u1' }),
        ticket({ store: 'st1', assigned_agent: null }),
        ticket({ store: 'st2', assigned_agent: 'u1' }),
      ],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    // st2 has no area manager, so only st1's two complaints carry an area.
    expect(d.byArea).toEqual([{ key: 'Aly', label: 'Aly', count: 2 }]);
    expect(d.byAgent.map((r) => [r.label, r.count])).toEqual([
      ['Amjad', 2],
      ['Unassigned', 1],
    ]);
  });

  it('filters by area manager', async () => {
    mockData({
      tickets: [ticket({ store: 'st1' }), ticket({ store: 'st2' })],
      stores: STORES,
      users: USERS,
    });
    expect((await run({ ...emptyComplaintFilters, area: 'Aly' })).total).toBe(1);
  });

  it('matches a partial customer mobile the way his filter does', async () => {
    const tickets = [
      ticket({ contact: { phone: '0551141059' } }),
      ticket({ contact: { phone: '0509876543' } }),
      ticket({ contact: null }),
    ];
    mockData({ tickets, stores: STORES, users: USERS });
    // "41059" is a fragment in the middle of the first number.
    expect((await run({ ...emptyComplaintFilters, phone: '41059' })).total).toBe(1);

    mockData({ tickets, stores: STORES, users: USERS });
    // Formatting must not defeat the match — digits are compared, not strings.
    expect((await run({ ...emptyComplaintFilters, phone: '055 114' })).total).toBe(1);
  });

  it('offers area options from the store master', async () => {
    mockData({ tickets: [], stores: STORES, users: USERS });
    const d = await run();
    expect(d.areaOptions).toEqual(['Aly']);
  });
});

describe('complaint dashboard — chat performance', () => {
  const CONVERSATIONS = [
    { id: 'c1', status: 'open', assigned_agent: 'u1' },
    { id: 'c2', status: 'closed', assigned_agent: 'u1' },
    { id: 'c3', status: 'open', assigned_agent: null },
  ];

  it('reports offered / answered / timed-out and the average wait per agent', async () => {
    mockData({
      tickets: [],
      stores: STORES,
      users: USERS,
      conversations: CONVERSATIONS,
      routing: [
        { id: 'r1', agent: 'u1', outcome: 'answered', seconds_held: 60 },
        { id: 'r2', agent: 'u1', outcome: 'answered', seconds_held: 120 },
        { id: 'r3', agent: 'u1', outcome: 'missed', seconds_held: 30 },
      ],
      messages: [{ sender_user: 'u1', count: 7 }],
    });
    const d = await run();
    const a = d.chatAgents.find((x) => x.id === 'u1')!;
    expect(a.offered).toBe(3);
    expect(a.answered).toBe(2);
    expect(a.missed).toBe(1);
    // Only ANSWERED events count toward the wait — a timed-out offer says
    // nothing about how long that agent made the customer wait.
    expect(a.avgWaitMinutes).toBe(1.5);
    expect(a.messages).toBe(7);
    expect(a.chatsHandled).toBe(2);
    expect(a.chatsSolved).toBe(1);
  });

  it('reads the alternate Directus aggregate shape for message counts', async () => {
    mockData({
      tickets: [],
      stores: STORES,
      users: USERS,
      conversations: CONVERSATIONS,
      messages: [{ group: { sender_user: 'u1' }, count: { '*': 12 } }],
    });
    const d = await run();
    expect(d.chatAgents.find((x) => x.id === 'u1')?.messages).toBe(12);
  });

  it('survives an aggregate the server refuses rather than blanking the page', async () => {
    request
      .mockResolvedValueOnce([]) // tickets
      .mockResolvedValueOnce(STORES)
      .mockResolvedValueOnce(USERS)
      .mockResolvedValueOnce([]) // csat
      .mockResolvedValueOnce(CONVERSATIONS)
      .mockResolvedValueOnce([]) // routing
      .mockRejectedValueOnce(new Error('forbidden')); // message aggregate
    const d = await run();
    expect(d.chatAgents.find((x) => x.id === 'u1')?.messages).toBe(0);
    expect(d.chatAgents.find((x) => x.id === 'u1')?.chatsHandled).toBe(2);
  });

  it('carries each agent chat workload onto the complaints table too', async () => {
    mockData({
      tickets: [ticket({ assigned_agent: 'u1' })],
      stores: STORES,
      users: USERS,
      conversations: CONVERSATIONS,
    });
    const d = await run();
    const a = d.agents.find((x) => x.id === 'u1')!;
    expect(a.chatsOpen).toBe(1);
    expect(a.chatsSolved).toBe(1);
  });
});

describe('complaint dashboard — service health composition', () => {
  it('splits the range into satisfied / unsatisfied / unrated / open / overdue', async () => {
    mockData({
      tickets: [
        ticket({ status: 'closed', conversation: 'c1' }),
        ticket({ status: 'closed', conversation: 'c2' }),
        ticket({ status: 'closed', conversation: null }),
        ticket({ status: 'open' }),
        ticket({
          status: 'open',
          first_responded_at: null,
          first_response_due_at: iso('2026-07-14T09:00:00Z'),
        }),
      ],
      stores: STORES,
      users: USERS,
      csat: [
        { id: 'r1', score: 5, conversation: 'c1' },
        { id: 'r2', score: 1, conversation: 'c2' },
      ],
    });
    const d = await run();
    expect(d.health.closedSatisfied).toBe(1);
    expect(d.health.closedUnsatisfied).toBe(1);
    expect(d.health.closedUnrated).toBe(1);
    // The overdue one is NOT double-counted as plain open — the strip has to
    // add up to the total or it is not a composition.
    expect(d.health.openNotOverdue).toBe(1);
    expect(d.health.overdue).toBe(1);
    const sum =
      d.health.closedSatisfied +
      d.health.closedUnsatisfied +
      d.health.closedUnrated +
      d.health.openNotOverdue +
      d.health.overdue;
    expect(sum).toBe(d.total);
  });

  it('averages the customer wait across every answered conversation', async () => {
    mockData({
      tickets: [],
      stores: STORES,
      users: USERS,
      routing: [
        { id: 'r1', agent: 'u1', outcome: 'answered', seconds_held: 30 },
        { id: 'r2', agent: 'u2', outcome: 'answered', seconds_held: 90 },
        { id: 'r3', agent: 'u2', outcome: 'missed', seconds_held: 300 },
      ],
    });
    const d = await run();
    expect(d.health.chatsAnswered).toBe(2);
    expect(d.health.avgChatWaitMinutes).toBe(1);
  });
});

describe('complaint dashboard — unsolved work per agent', () => {
  it('ranks who is holding open complaints, not who logged the most', async () => {
    mockData({
      tickets: [
        // Amjad logs a lot but finishes everything.
        ticket({ assigned_agent: 'u1', status: 'closed' }),
        ticket({ assigned_agent: 'u1', status: 'closed' }),
        ticket({ assigned_agent: 'u1', status: 'closed' }),
        // Sara logs less but is sitting on two.
        ticket({ assigned_agent: 'u2', status: 'open' }),
        ticket({ assigned_agent: 'u2', status: 'pending' }),
      ],
      stores: STORES,
      users: [...USERS, { id: 'u2', first_name: 'Sara', last_name: null, email: 's@x.com' }],
    });
    const d = await run();
    // The busiest agent leads "by agent"...
    expect(d.byAgent[0]?.label).toBe('Amjad');
    // ...but is absent from the unsolved list entirely, which is the point.
    expect(d.byOpenAgent).toEqual([{ key: 'u2', label: 'Sara', count: 2 }]);
    expect(d.open).toBe(2);
  });

  it('leaves the unsolved list empty when everything is closed', async () => {
    mockData({
      tickets: [ticket({ status: 'closed' }), ticket({ status: 'resolved' })],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    expect(d.byOpenAgent).toEqual([]);
  });

  it('names unassigned open complaints rather than dropping them', async () => {
    mockData({
      tickets: [ticket({ assigned_agent: null, status: 'open' })],
      stores: STORES,
      users: USERS,
    });
    const d = await run();
    expect(d.byOpenAgent).toEqual([{ key: '', label: 'Unassigned', count: 1 }]);
  });

  it('does not cap the unsolved list — every agent holding work must show', async () => {
    const users = Array.from({ length: 14 }, (_, i) => ({
      id: `a${i}`,
      first_name: `Agent${i}`,
      last_name: null,
      email: null,
    }));
    mockData({
      tickets: users.map((u) => ticket({ assigned_agent: u.id, status: 'open' })),
      stores: STORES,
      users,
    });
    const d = await run();
    // The ranked "by agent" cut still tops out at 10; the chase list does not.
    expect(d.byAgent).toHaveLength(10);
    expect(d.byOpenAgent).toHaveLength(14);
  });
});
