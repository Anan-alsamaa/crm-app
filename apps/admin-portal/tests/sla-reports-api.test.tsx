import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
// So the stub can answer by COLLECTION rather than by call order — see mockData.
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readUsers: (opts: unknown) => ({ collection: 'directus_users', opts }),
}));

import { useSlaReports } from '../src/features/sla-reports/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

// Fixed reference clock so "pending vs breached" is deterministic.
const NOW = new Date('2026-07-01T12:00:00.000Z').getTime();
const past = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const future = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

beforeEach(() => {
  request.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

/**
 * Answer each read by COLLECTION, never by call order.
 *
 * This stub used to queue two resolutions positionally, so adding the
 * conversations read for chat first response silently handed the tickets
 * fixture to the wrong query and every assertion in the file failed with
 * "expected false to be true" — a message that says nothing about the cause.
 * Dispatching by collection removes the coupling: a new read defaults to `[]`
 * and the suite keeps passing.
 */
function mockData(
  tickets: unknown[],
  users: unknown[] = [{ id: 'u1', first_name: 'Ann', last_name: 'Lee', email: 'a@x.com' }],
  chats: unknown[] = [],
) {
  const byCollection: Record<string, unknown[]> = {
    tickets,
    conversations: chats,
    directus_users: users,
  };
  request.mockImplementation(async (arg: unknown) => {
    const key = (arg as { collection?: string } | null)?.collection ?? '';
    return byCollection[key] ?? [];
  });
}

describe('sla-reports api', () => {
  it('useSlaReports returns empty totals when there are no tickets', async () => {
    mockData([]);
    const { result } = renderHook(() => useSlaReports(7), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const data = result.current.data!;
    expect(data.tickets).toEqual([]);
    expect(data.agents).toEqual([]);
    expect(data.totals).toEqual({
      tickets: 0,
      // Null, not 0%. No chat in the range carried a first-response clock, and
      // a confident "0%" would report a failure that never happened.
      frPct: null,
      frChats: 0,
      resPct: null,
      breaches: 0,
    });
    // tickets + conversations + users.
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('classifies met / breached-late / breached-overdue / pending / na across all branches', async () => {
    mockData([
      // met FR (responded before due), met resolution
      {
        id: 't1',
        subject: 'Met both',
        status: 'closed',
        priority: 'high',
        assigned_agent: 'u1',
        date_created: past(5),
        first_response_due_at: past(3),
        first_responded_at: past(4),
        resolution_due_at: past(1),
        resolved_at: past(2),
      },
      // breached FR (responded after due), breached resolution (overdue, no resolved_at)
      {
        id: 't2',
        subject: 'Breached',
        status: 'open',
        priority: 'low',
        assigned_agent: 'u1',
        date_created: past(10),
        first_response_due_at: past(9),
        first_responded_at: past(8),
        resolution_due_at: past(1),
        resolved_at: null,
      },
      // pending FR (due in future, not responded), na resolution (no due target)
      {
        id: 't3',
        subject: null,
        status: 'open',
        priority: 'medium',
        assigned_agent: null,
        date_created: past(1),
        first_response_due_at: future(2),
        first_responded_at: null,
        resolution_due_at: null,
        resolved_at: null,
      },
    ]);
    const { result } = renderHook(() => useSlaReports(30), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const data = result.current.data!;

    expect(data.tickets).toHaveLength(3);
    const t1 = data.tickets.find((t) => t.id === 't1')!;
    expect(t1.firstResponse.state).toBe('met');
    expect(t1.resolution.state).toBe('met');
    expect(t1.agentName).toBe('Ann Lee');
    expect(t1.responseMinutes).toBe(60); // created 5h ago, responded 4h ago = 60 min

    const t2 = data.tickets.find((t) => t.id === 't2')!;
    expect(t2.firstResponse.state).toBe('breached');
    expect(t2.resolution.state).toBe('breached'); // overdue, no resolved_at

    const t3 = data.tickets.find((t) => t.id === 't3')!;
    expect(t3.firstResponse.state).toBe('pending');
    expect(t3.resolution.state).toBe('na');
    expect(t3.subject).toBe('(no subject)');
    expect(t3.agentName).toBe('Unassigned');
    expect(t3.agentId).toBeNull();
    expect(t3.responseMinutes).toBeNull();

    /*
     * Resolution met=1, breached=1 -> 50%, and ONE breach in the headline.
     *
     * The ticket first-response states above are still computed from the
     * ticket's own columns, but they no longer reach the headline: those
     * columns are never written any more, so counting them added a confident
     * percentage of nothing to the tile and a breach the reader could not find
     * in any row beneath it. First response is now a CHAT measure — see the
     * test below.
     */
    expect(data.totals.tickets).toBe(3);
    expect(data.totals.resPct).toBe(50);
    expect(data.totals.breaches).toBe(1);
    expect(data.totals.frPct).toBeNull();
  });

  it('measures first response on the CHATS, which is where the promise is kept', async () => {
    /*
     * A ticket is raised out of a conversation an agent has already answered,
     * so a first response timed from the ticket's creation re-judges a reply
     * made before the ticket existed. That is how the previous version came to
     * report six permanent breaches nobody could act on.
     *
     * Answered inside the deadline is met; answered after it, or still
     * unanswered past it, is breached; still unanswered INSIDE it is undecided
     * and counts towards neither, because nothing has gone wrong yet.
     */
    mockData([], undefined, [
      { id: 'c-met', first_response_due_at: past(4), first_responded_at: past(5) },
      { id: 'c-late', first_response_due_at: past(4), first_responded_at: past(3) },
      { id: 'c-overdue', first_response_due_at: past(1), first_responded_at: null },
      { id: 'c-waiting', first_response_due_at: future(1), first_responded_at: null },
      // No clock at all: it started before the policy existed, so it was
      // never promised anything and must not count as a miss.
      { id: 'c-unpromised', first_response_due_at: null, first_responded_at: null },
    ]);
    const { result } = renderHook(() => useSlaReports(30), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const totals = result.current.data!.totals;

    // 1 met out of 3 decided.
    expect(totals.frChats).toBe(3);
    expect(totals.frPct).toBeCloseTo(33.33, 1);
  });

  it('groups per agent, buckets unassigned, and sorts by breaches then tickets', async () => {
    mockData([
      // Agent u1: 1 breached FR
      {
        id: 't1',
        subject: 'A',
        status: 'open',
        priority: 'high',
        assigned_agent: 'u1',
        date_created: past(10),
        first_response_due_at: past(9),
        first_responded_at: past(8),
        resolution_due_at: null,
        resolved_at: null,
      },
      // Unassigned: 1 met FR with avg response, met resolution
      {
        id: 't2',
        subject: 'B',
        status: 'closed',
        priority: 'low',
        assigned_agent: null,
        date_created: past(5),
        first_response_due_at: past(3),
        first_responded_at: past(4),
        resolution_due_at: past(1),
        resolved_at: past(2),
      },
    ]);
    const { result } = renderHook(() => useSlaReports(14), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const data = result.current.data!;

    expect(data.agents).toHaveLength(2);
    // u1 has a breach so sorts first.
    const a0 = data.agents[0]!;
    expect(a0.agentId).toBe('u1');
    expect(a0.breaches).toBe(1);
    expect(a0.frBreached).toBe(1);
    expect(a0.frPct).toBe(0); // 0 met of 1 decided
    expect(a0.resPct).toBeNull(); // no resolution target -> na
    expect(a0.avgResponseMin).toBe(120); // created 10h ago, responded 8h ago

    const unassigned = data.agents.find((a) => a.agentId === null)!;
    expect(unassigned.agentName).toBe('Unassigned');
    expect(unassigned.frMet).toBe(1);
    expect(unassigned.frPct).toBe(100);
    expect(unassigned.resMet).toBe(1);
    expect(unassigned.resPct).toBe(100);
    expect(unassigned.avgResponseMin).toBe(60); // one responded ticket, 60 min
    expect(unassigned.breaches).toBe(0);
  });

  it('falls back to email / dash for user display names and unknown agents', async () => {
    mockData(
      [
        {
          id: 't1',
          subject: 'X',
          status: 'open',
          priority: 'high',
          assigned_agent: 'u2', // email-only user
          date_created: past(2),
          first_response_due_at: future(1),
          first_responded_at: null,
          resolution_due_at: null,
          resolved_at: null,
        },
        {
          id: 't2',
          subject: 'Y',
          status: 'open',
          priority: 'high',
          assigned_agent: 'ghost', // not in user map -> '—'
          date_created: past(2),
          first_response_due_at: future(1),
          first_responded_at: null,
          resolution_due_at: null,
          resolved_at: null,
        },
      ],
      [
        { id: 'u2', first_name: null, last_name: null, email: 'only@mail.com' },
        { id: 'u3', first_name: null, last_name: null, email: null }, // -> '—'
      ],
    );
    const { result } = renderHook(() => useSlaReports(7), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const data = result.current.data!;
    expect(data.tickets.find((t) => t.id === 't1')!.agentName).toBe('only@mail.com');
    expect(data.tickets.find((t) => t.id === 't2')!.agentName).toBe('—');
  });
});
