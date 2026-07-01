import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import { useDashboardMetrics } from '../src/features/dashboard/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const NOW = new Date('2026-07-01T12:00:00.000Z').getTime();
const past = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const future = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

beforeEach(() => {
  request.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

/** Queue the five directus.request calls in order: conversations, tickets, csat, users, vendors. */
function mockData(opts: {
  conversations?: unknown[];
  tickets?: unknown[];
  csat?: unknown[];
  users?: unknown[];
  vendors?: unknown[];
}) {
  request
    .mockResolvedValueOnce(opts.conversations ?? [])
    .mockResolvedValueOnce(opts.tickets ?? [])
    .mockResolvedValueOnce(opts.csat ?? [])
    .mockResolvedValueOnce(
      opts.users ?? [{ id: 'u1', first_name: 'Ann', last_name: 'Lee', email: 'a@x.com' }],
    )
    .mockResolvedValueOnce(opts.vendors ?? [{ id: 'v1', name: 'Acme' }]);
}

describe('dashboard api', () => {
  it('returns zeroed / null metrics when all collections are empty', async () => {
    mockData({});
    const { result } = renderHook(() => useDashboardMetrics(7), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const d = result.current.data!;
    expect(d.conversationVolume).toBe(0);
    expect(d.conversationsByStatus).toEqual({});
    expect(d.volumeSeries).toEqual([]);
    expect(d.avgResponseMinutes).toBeNull();
    expect(d.slaCompliancePct).toBeNull();
    expect(d.ticketResolutionPct).toBeNull();
    expect(d.ticketTotal).toBe(0);
    expect(d.csatAvg).toBeNull();
    expect(d.csatCount).toBe(0);
    expect(d.topAgents).toEqual([]);
    expect(d.topVendors).toEqual([]);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('aggregates conversation volume, status breakdown, day series and top vendors', async () => {
    mockData({
      conversations: [
        { id: 'c1', status: 'open', date_created: '2026-06-30T09:00:00.000Z', vendor: 'v1' },
        { id: 'c2', status: 'open', date_created: '2026-06-30T15:00:00.000Z', vendor: 'v1' },
        { id: 'c3', status: 'closed', date_created: '2026-06-29T10:00:00.000Z', vendor: 'v2' },
        // no date_created (day branch skipped) and no vendor
        { id: 'c4', status: 'open', date_created: null, vendor: null },
      ],
      vendors: [{ id: 'v1', name: 'Acme' }],
    });
    const { result } = renderHook(() => useDashboardMetrics(30), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const d = result.current.data!;

    expect(d.conversationVolume).toBe(4);
    expect(d.conversationsByStatus).toEqual({ open: 3, closed: 1 });
    // Two days, sorted ascending; c4 has no day so is excluded.
    expect(d.volumeSeries).toEqual([
      { day: '2026-06-29', count: 1 },
      { day: '2026-06-30', count: 2 },
    ]);
    // v1 has a name; v2 falls back to its id.
    expect(d.topVendors).toEqual([
      { id: 'v1', name: 'Acme', conversations: 2 },
      { id: 'v2', name: 'v2', conversations: 1 },
    ]);
  });

  it('computes response time, SLA compliance, resolution rate and top agents from tickets', async () => {
    mockData({
      tickets: [
        // resolved by u1, responded on time (30 min), SLA eligible + on time
        {
          id: 't1',
          status: 'resolved',
          date_created: past(5),
          first_responded_at: new Date(NOW - 4.5 * 3_600_000).toISOString(),
          first_response_due_at: past(3),
          assigned_agent: 'u1',
        },
        // closed by u1, no response data
        {
          id: 't2',
          status: 'closed',
          date_created: past(6),
          first_responded_at: null,
          first_response_due_at: null,
          assigned_agent: 'u1',
        },
        // open, SLA eligible but not on time (never responded)
        {
          id: 't3',
          status: 'open',
          date_created: past(10),
          first_responded_at: null,
          first_response_due_at: past(4),
          assigned_agent: 'u2',
        },
        // resolved but no assigned_agent (agent branch skipped)
        {
          id: 't4',
          status: 'resolved',
          date_created: past(3),
          first_responded_at: null,
          first_response_due_at: future(1),
          assigned_agent: null,
        },
      ],
      users: [
        { id: 'u1', first_name: 'Ann', last_name: 'Lee', email: 'a@x.com' },
        // u2 not present -> name falls back to id
      ],
    });
    const { result } = renderHook(() => useDashboardMetrics(30), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const d = result.current.data!;

    expect(d.ticketTotal).toBe(4);
    // Only t1 has both created + responded -> 30 min average.
    expect(d.avgResponseMinutes).toBe(30);
    // SLA eligible: t1, t3, t4 = 3; on time: t1 only -> 33.33%.
    expect(d.slaCompliancePct).toBeCloseTo((1 / 3) * 100, 5);
    // resolved/closed: t1, t2, t4 = 3 of 4 -> 75%.
    expect(d.ticketResolutionPct).toBe(75);
    // top agents: u1 resolved 2 (t1,t2), sorted first; t4 unassigned excluded.
    expect(d.topAgents).toEqual([{ id: 'u1', name: 'Ann Lee', resolved: 2 }]);
  });

  it('averages CSAT scores and ignores non-numeric scores', async () => {
    mockData({
      csat: [
        { id: 'r1', score: 4 },
        { id: 'r2', score: 2 },
        { id: 'r3', score: null },
      ],
    });
    const { result } = renderHook(() => useDashboardMetrics(7), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const d = result.current.data!;
    expect(d.csatCount).toBe(2);
    expect(d.csatAvg).toBe(3); // (4 + 2) / 2
  });

  it('caps top agents and vendors at 5 entries', async () => {
    const tickets = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      status: 'resolved',
      date_created: past(2),
      first_responded_at: null,
      first_response_due_at: null,
      assigned_agent: `agent${i}`,
    }));
    const conversations = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      status: 'open',
      date_created: '2026-06-30T09:00:00.000Z',
      vendor: `vend${i}`,
    }));
    mockData({ tickets, conversations, users: [], vendors: [] });
    const { result } = renderHook(() => useDashboardMetrics(30), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const d = result.current.data!;
    expect(d.topAgents).toHaveLength(5);
    expect(d.topVendors).toHaveLength(5);
  });
});
