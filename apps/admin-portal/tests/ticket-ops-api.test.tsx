import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import { useTicketOps } from '../src/features/ticket-ops/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

// Fixed reference clock so "overdue" and "age" are deterministic.
const NOW = new Date('2026-07-01T12:00:00.000Z').getTime();
const past = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const future = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

beforeEach(() => {
  request.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

/** Queue the three directus.request calls (tickets, users, teams) in order. */
function mockData(
  tickets: unknown[],
  users: unknown[] = [
    { id: 'u1', first_name: 'Ann', last_name: 'Lee', email: 'ann@x.com' },
    { id: 'u2', first_name: 'Bo', last_name: 'Ray', email: 'bo@x.com' },
  ],
  teams: unknown[] = [{ id: 'tm1', name: 'Tier 1' }],
) {
  request.mockResolvedValueOnce(tickets).mockResolvedValueOnce(users).mockResolvedValueOnce(teams);
}

function raw(over: Record<string, unknown> = {}) {
  return {
    id: 'x',
    subject: 'Subject',
    status: 'open',
    priority: 'medium',
    assigned_agent: 'u1',
    assigned_team: 'tm1',
    date_created: past(4),
    first_responded_at: null,
    resolution_due_at: null,
    resolved_at: null,
    closed_at: null,
    contact: null,
    ...over,
  };
}

/** Render the hook and settle it. Call `mockData(...)` first. */
async function load(days = 30) {
  const { result } = renderHook(() => useTicketOps(days), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data!;
}

/**
 * A window covering every branch of the aggregation: each lifecycle status, an
 * unassigned open ticket, an overdue open ticket, a past-due but already
 * resolved ticket (must NOT count as overdue), and enough timings for median
 * to differ from average.
 */
function fullWindow() {
  return [
    // resolved: due date already passed, but it IS done -> not overdue.
    raw({
      id: 't-res',
      status: 'resolved',
      priority: 'low',
      assigned_agent: 'u2',
      date_created: past(20),
      first_responded_at: past(19),
      resolution_due_at: past(1),
      resolved_at: past(18),
    }),
    // open + unassigned + past its resolution due -> overdue AND unassigned.
    raw({
      id: 't-open',
      status: 'open',
      priority: 'urgent',
      assigned_agent: null,
      assigned_team: null,
      date_created: past(5),
      resolution_due_at: past(1),
    }),
    // closed, long resolution.
    raw({
      id: 't-closed',
      status: 'closed',
      priority: 'medium',
      assigned_agent: 'u2',
      date_created: past(40),
      resolution_due_at: future(2),
      resolved_at: past(30),
      closed_at: past(29),
    }),
    // new, responded quickly, due in the future -> not overdue.
    raw({
      id: 't-new',
      status: 'new',
      priority: 'high',
      assigned_agent: 'u1',
      date_created: past(10),
      first_responded_at: past(9),
      resolution_due_at: future(4),
    }),
    // second closed ticket so resolutionMins has an odd length.
    raw({
      id: 't-closed2',
      status: 'closed',
      priority: 'low',
      assigned_agent: 'u2',
      date_created: past(12),
      resolved_at: past(7),
      closed_at: past(6),
    }),
    // pending, awaiting the customer.
    raw({
      id: 't-pending',
      status: 'pending',
      priority: 'medium',
      assigned_agent: 'u1',
      date_created: past(4),
      first_responded_at: past(2),
    }),
  ];
}

describe('ticket-ops api — useTicketOps', () => {
  it('queries tickets, users and teams and returns empty aggregates for no tickets', async () => {
    mockData([]);
    const data = await load();

    expect(request).toHaveBeenCalledTimes(3);
    expect(data.rows).toEqual([]);
    expect(data.totals).toEqual({
      total: 0,
      open: 0,
      pending: 0,
      resolved: 0,
      closed: 0,
      overdue: 0,
      unassigned: 0,
    });
    expect(data.byStatus).toEqual([]);
    expect(data.byPriority).toEqual([]);
    expect(data.agents).toEqual([]);
    expect(data.timing).toEqual({
      medianResponseMin: null,
      medianResolutionMin: null,
      avgResolutionMin: null,
    });
  });

  it('counts the open backlog as new + open + pending', async () => {
    mockData(fullWindow());
    const data = await load();

    expect(data.totals.total).toBe(6);
    expect(data.totals.open).toBe(3); // t-open + t-new + t-pending
    expect(data.totals.pending).toBe(1);
    expect(data.totals.resolved).toBe(1);
    expect(data.totals.closed).toBe(2);
  });

  it('counts overdue only when the resolution due date passed AND the ticket is live', async () => {
    mockData(fullWindow());
    const data = await load();

    // t-res is past due but resolved; t-closed/t-new are due in the future.
    expect(data.totals.overdue).toBe(1);
    expect(data.rows.find((r) => r.id === 't-open')!.overdue).toBe(true);
    expect(data.rows.find((r) => r.id === 't-res')!.overdue).toBe(false);
    expect(data.rows.find((r) => r.id === 't-new')!.overdue).toBe(false);
  });

  it('counts unassigned only within the open backlog', async () => {
    mockData([
      raw({ id: 'a', status: 'open', assigned_agent: null }),
      // Unassigned but already closed -> must not inflate the unassigned KPI.
      raw({ id: 'b', status: 'closed', assigned_agent: null, resolved_at: past(1) }),
    ]);
    const data = await load();
    expect(data.totals.unassigned).toBe(1);
    expect(data.totals.open).toBe(1);
  });

  it('exposes age only for live tickets and computes lifecycle minutes', async () => {
    mockData(fullWindow());
    const data = await load();

    const open = data.rows.find((r) => r.id === 't-open')!;
    expect(open.ageHours).toBe(5);
    expect(open.responseMinutes).toBeNull();
    expect(open.resolutionMinutes).toBeNull();

    const neu = data.rows.find((r) => r.id === 't-new')!;
    expect(neu.responseMinutes).toBe(60); // created 10h ago, responded 9h ago

    const res = data.rows.find((r) => r.id === 't-res')!;
    expect(res.ageHours).toBeNull(); // resolved -> no age
    expect(res.resolutionMinutes).toBe(120); // created 20h ago, resolved 18h ago
  });

  it('reports a median that differs from the average resolution time', async () => {
    mockData(fullWindow());
    const data = await load();

    // Response minutes: [60 (t-res), 60 (t-new), 120 (t-pending)] -> odd median.
    expect(data.timing.medianResponseMin).toBe(60);
    // Resolution minutes: [120, 600, 300] -> sorted [120, 300, 600].
    expect(data.timing.medianResolutionMin).toBe(300);
    expect(data.timing.avgResolutionMin).toBe(340);
  });

  it('averages the two middle values when the sample size is even', async () => {
    mockData([
      raw({ id: 'a', status: 'closed', date_created: past(4), resolved_at: past(3) }), // 60
      raw({ id: 'b', status: 'closed', date_created: past(6), resolved_at: past(3) }), // 180
    ]);
    const data = await load();
    expect(data.timing.medianResolutionMin).toBe(120);
    expect(data.timing.avgResolutionMin).toBe(120);
  });

  it('orders byStatus by lifecycle and byPriority by severity, not by count', async () => {
    mockData(fullWindow());
    const data = await load();

    expect(data.byStatus).toEqual([
      { key: 'new', count: 1 },
      { key: 'open', count: 1 },
      { key: 'pending', count: 1 },
      { key: 'resolved', count: 1 },
      { key: 'closed', count: 2 },
    ]);
    expect(data.byPriority).toEqual([
      { key: 'urgent', count: 1 },
      { key: 'high', count: 1 },
      { key: 'medium', count: 2 },
      { key: 'low', count: 2 },
    ]);
  });

  it('groups load per agent (incl. an Unassigned bucket) sorted by overdue, open, total', async () => {
    mockData(fullWindow());
    const data = await load();

    expect(data.agents.map((a) => a.agentName)).toEqual(['Unassigned', 'Ann Lee', 'Bo Ray']);

    const [unassigned, ann, bo] = data.agents;
    // Unassigned sorts first: it owns the only overdue ticket.
    expect(unassigned).toMatchObject({
      agentId: null,
      total: 1,
      open: 1,
      overdue: 1,
      resolved: 0,
      avgResolutionMin: null,
    });
    // Ann carries more live work than Bo, so she outranks him on `open`.
    expect(ann).toMatchObject({ agentId: 'u1', total: 2, open: 2, overdue: 0, resolved: 0 });
    // Bo's three tickets are all done; avg of 120, 600 and 300 minutes.
    expect(bo).toMatchObject({ agentId: 'u2', total: 3, open: 0, overdue: 0, resolved: 3 });
    expect(bo!.avgResolutionMin).toBe(340);
  });

  it('lifts customerId / yijiVendorId off the nested contact', async () => {
    mockData([
      raw({
        id: 'linked',
        contact: {
          id: 'c1',
          name: 'Dana Ali',
          external_customer_id: 'cust-9',
          vendor: { yiji_vendor_id: 'v-7' },
        },
      }),
      raw({
        id: 'no-vendor',
        contact: {
          id: 'c2',
          name: 'Sam',
          external_customer_id: 'cust-1',
          vendor: null,
        },
      }),
      raw({ id: 'no-contact', contact: null }),
    ]);
    const data = await load();

    expect(data.rows.find((r) => r.id === 'linked')).toMatchObject({
      contactName: 'Dana Ali',
      customerId: 'cust-9',
      yijiVendorId: 'v-7',
    });
    expect(data.rows.find((r) => r.id === 'no-vendor')).toMatchObject({
      customerId: 'cust-1',
      yijiVendorId: null,
    });
    expect(data.rows.find((r) => r.id === 'no-contact')).toMatchObject({
      contactName: '—',
      customerId: null,
      yijiVendorId: null,
    });
  });

  it('falls back for missing subjects, agents and teams', async () => {
    mockData(
      [
        raw({ id: 'a', subject: null, assigned_agent: 'ghost', assigned_team: 'gone' }),
        raw({ id: 'b', assigned_agent: 'u3', assigned_team: null }),
        raw({ id: 'c', assigned_agent: null }),
      ],
      [
        { id: 'u3', first_name: null, last_name: null, email: 'only@mail.com' },
        { id: 'u4', first_name: null, last_name: null, email: null },
      ],
      [{ id: 'tm1', name: null }],
    );
    const data = await load();

    const a = data.rows.find((r) => r.id === 'a')!;
    expect(a.subject).toBe('(no subject)');
    expect(a.agentName).toBe('—'); // agent id not in the user map
    expect(a.teamName).toBe('—'); // team id not in the team map

    const b = data.rows.find((r) => r.id === 'b')!;
    expect(b.agentName).toBe('only@mail.com'); // name-less user falls back to email
    expect(b.teamName).toBe('—'); // no team assigned

    const c = data.rows.find((r) => r.id === 'c')!;
    expect(c.agentName).toBe('Unassigned');
    expect(c.agentId).toBeNull();
    expect(c.teamName).toBe('—'); // team row with a null name
  });
});
