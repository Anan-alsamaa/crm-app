import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  summariseOpenTickets,
  useOpenTicketStats,
  type OpenTicketRaw,
} from '../src/features/sla-reports/open-tickets.js';

/*
 * The open-ticket backlog on the Ticket deadlines page (owner, 2026-10-07).
 * "Open" is the ticket state `pending`; stored rows are not migrated, so the
 * retired `open`/`new` must count and `closed`/`resolved`/`solved` must not.
 */
const NOW = new Date('2026-10-07T12:00:00.000Z').getTime();
const h = (n: number) => new Date(NOW + n * 3_600_000).toISOString();

const row = (over: Partial<OpenTicketRaw> = {}): OpenTicketRaw => ({
  id: Math.random().toString(36).slice(2),
  status: 'pending',
  priority: 'medium',
  assigned_agent: 'u1',
  resolution_due_at: null,
  store_snapshot: null,
  store: null,
  ...over,
});
const users = [
  { id: 'u1', first_name: 'Ann', last_name: 'Lee', email: null },
  { id: 'u2', first_name: null, last_name: null, email: 'bo@x.com' },
];

describe('summariseOpenTickets', () => {
  it('counts every unsolved spelling as pending and ignores every solved one', () => {
    const s = summariseOpenTickets(
      [
        row({ status: 'pending' }),
        row({ status: 'open' }),
        row({ status: 'new' }),
        row({ status: null }),
        row({ status: 'solved' }),
        row({ status: 'closed' }),
        row({ status: 'resolved' }),
      ],
      users,
      NOW,
    );
    expect(s.total).toBe(4);
  });

  it('splits deadlines into overdue, due within 24h, later, and none', () => {
    const s = summariseOpenTickets(
      [
        row({ resolution_due_at: h(-2) }), // overdue
        row({ resolution_due_at: h(-0.1) }), // overdue
        row({ resolution_due_at: h(3) }), // due soon
        row({ resolution_due_at: h(24) }), // due soon (boundary inclusive)
        row({ resolution_due_at: h(30) }), // later — in total only
        row({ resolution_due_at: null }), // no deadline
      ],
      users,
      NOW,
    );
    expect(s).toMatchObject({ total: 6, overdue: 2, dueSoon: 2, noDeadline: 1 });
  });

  it('orders priority by severity, not by count', () => {
    const s = summariseOpenTickets(
      [
        row({ priority: 'low' }),
        row({ priority: 'low' }),
        row({ priority: 'urgent' }),
        row({ priority: 'high' }),
        row({ priority: null }), // reads as medium
      ],
      users,
      NOW,
    );
    expect(s.byPriority).toEqual([
      { key: 'urgent', count: 1 },
      { key: 'high', count: 1 },
      { key: 'medium', count: 1 },
      { key: 'low', count: 2 },
    ]);
  });

  it('groups by agent, worst first, with an Unassigned bucket keyed null', () => {
    const s = summariseOpenTickets(
      [
        row({ assigned_agent: 'u1' }),
        row({ assigned_agent: 'u1' }),
        row({ assigned_agent: 'u2', resolution_due_at: h(-1) }),
        row({ assigned_agent: null }),
        row({ assigned_agent: 'ghost' }),
      ],
      users,
      NOW,
    );
    expect(s.byAgent).toEqual([
      { key: 'u2', name: 'bo@x.com', pending: 1, overdue: 1 },
      { key: 'u1', name: 'Ann Lee', pending: 2, overdue: 0 },
      { key: 'ghost', name: '—', pending: 1, overdue: 0 },
      { key: null, name: 'Unassigned', pending: 1, overdue: 0 },
    ]);
  });

  it('takes the brand frozen on the ticket first, the live store second', () => {
    const snap = (brandName: string) =>
      ({ brandName }) as unknown as OpenTicketRaw['store_snapshot'];
    const s = summariseOpenTickets(
      [
        row({ store_snapshot: snap('Casa Pasta'), store: { brand: { name: 'Moved Brand' } } }),
        row({ store: { brand: { name: 'Casa Pasta' } }, resolution_due_at: h(-1) }),
        row({}),
      ],
      users,
      NOW,
    );
    expect(s.byBrand).toEqual([
      { key: 'Casa Pasta', name: 'Casa Pasta', pending: 2, overdue: 1 },
      { key: null, name: 'No brand', pending: 1, overdue: 0 },
    ]);
  });
});

describe('useOpenTicketStats', () => {
  function wrapper() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
  }
  beforeEach(() => request.mockReset());

  it('asks the server for every unsolved spelling, and for a missing status', async () => {
    request.mockResolvedValueOnce([row({ status: 'open' })]).mockResolvedValueOnce(users);
    const { result } = renderHook(() => useOpenTicketStats(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(1);

    const [builder] = request.mock.calls[0] as [
      (c: unknown) => { params: { filter?: { _or?: Array<Record<string, unknown>> } } },
    ];
    const or = builder({}).params.filter?._or ?? [];
    const inList = (or[0] as { status: { _in: string[] } }).status._in;
    expect([...inList].sort()).toEqual(['new', 'open', 'pending']);
    expect(or[1]).toEqual({ status: { _null: true } });
  });

  it('falls back to the plain columns when the store expansion is refused', async () => {
    request
      .mockRejectedValueOnce(new Error('403'))
      .mockResolvedValueOnce(users)
      .mockResolvedValueOnce([row()]);
    const { result } = renderHook(() => useOpenTicketStats(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(1);
    expect(result.current.data?.byBrand[0]?.key).toBeNull();
  });
});
