import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/*
 * WHAT EACH REPORT FETCHES (2026-10-05).
 *
 * After the 7,912-ticket history import, the loader behind Agent summary,
 * Conversations and the ticket breakdown took 5.1 s on the default range and
 * 17.8 s on the full history, measured on production. It fetched everything
 * for every report: every ticket row in full to count tickets per agent, every
 * chat for a breakdown that shows none, every revision of every ticket 120 ids
 * at a time, and 7,646 rows to count one number — mostly one request after
 * another. These pin down the leaner shape.
 */

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readUsers: (opts: unknown) => ({ collection: 'directus_users', opts }),
  readRevisions: (opts: unknown) => ({ collection: 'directus_revisions', opts }),
  aggregate: (collection: string, opts: unknown) => ({ collection, opts, aggregate: true }),
}));

import { useAgentReportData, type AgentReportKind } from '../src/features/report-exports/api.js';

interface Captured {
  collection: string;
  aggregate?: boolean;
  opts: {
    fields?: unknown[];
    filter?: Record<string, unknown>;
    groupBy?: string[];
    query?: { filter?: unknown };
  };
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const labels = { unassigned: 'Unassigned', noSubject: '(none)' };
const calls = () => request.mock.calls.map(([arg]) => arg as Captured);
const reads = (collection: string) =>
  calls().filter((c) => c.collection === collection && !c.aggregate);
const aggregates = (collection: string) =>
  calls().filter((c) => c.collection === collection && c.aggregate);

let answer: (c: Captured) => unknown;
beforeEach(() => {
  request.mockReset();
  answer = () => [];
  request.mockImplementation(async (q: unknown) => answer(q as Captured));
});

async function load(kind?: AgentReportKind) {
  const { result } = renderHook(
    () => useAgentReportData(0, labels, { from: '2026-09-01', to: '2026-09-30' }, kind),
    { wrapper: wrapper() },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data!;
}

describe('Agent summary', () => {
  it('counts tickets per agent on the server instead of downloading them', async () => {
    answer = (c) => {
      if (c.collection === 'directus_users')
        return [{ id: 'u1', first_name: 'Ann', last_name: null, email: 'a@x.com' }];
      if (c.collection === 'tickets' && c.aggregate)
        // Directus returns the count as a STRING.
        return [
          { assigned_agent: 'u1', count: '50' },
          { assigned_agent: null, count: '7' },
        ];
      return [];
    };
    const data = await load('agents');

    expect(reads('tickets'), 'the ticket rows were downloaded').toHaveLength(0);
    const [count] = aggregates('tickets');
    expect(count?.opts.groupBy).toEqual(['assigned_agent']);
    // Same window as the rows: when the complaint happened.
    expect(JSON.stringify(count?.opts.query?.filter)).toContain('complaint_date');
    expect(data.agents.find((a) => a.agentId === 'u1')?.tickets).toBe(50);
    expect(data.agents.find((a) => a.agentId === null)?.tickets).toBe(7);
  });

  it('does not read what only the ticket breakdown shows', async () => {
    await load('agents');
    expect(reads('coupon_approvals')).toHaveLength(0);
    expect(reads('directus_revisions')).toHaveLength(0);
  });
});

describe('Conversation status', () => {
  it('reads chats and nothing about tickets, CSAT or routing', async () => {
    await load('conversations');
    expect(reads('conversations')).toHaveLength(1);
    expect(calls().filter((c) => c.collection === 'tickets')).toHaveLength(0);
    expect(reads('csat_responses')).toHaveLength(0);
    expect(reads('routing_events')).toHaveLength(0);
    expect(reads('coupon_approvals')).toHaveLength(0);
  });
});

describe('Ticket breakdown', () => {
  it('reads only the ticket fields it renders, snapshots included', async () => {
    await load('complaints');
    const [tickets] = reads('tickets');
    const fields = JSON.stringify(tickets?.opts.fields);
    // What the columns need…
    for (const f of [
      'complaint_date',
      'description',
      'order_snapshot',
      'store_snapshot',
      'order_id',
    ])
      expect(fields, f).toContain(`"${f}"`);
    // …and not the SLA and audit stamps no column of it shows.
    for (const f of ['subject', 'first_response_due_at', 'resolution_due_at', 'user_updated'])
      expect(fields, f).not.toContain(`"${f}"`);
    // No chats: the breakdown shows none.
    expect(reads('conversations')).toHaveLength(0);
    expect(reads('messages')).toHaveLength(0);
  });

  it('finds the last human editor with ONE revisions query, newest first', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `t${i}`);
    answer = (c) => {
      if (c.collection === 'directus_users')
        return [
          { id: 'u1', first_name: 'Ann', last_name: null, email: 'a@x.com' },
          { id: 'u2', first_name: 'Bob', last_name: null, email: 'b@x.com' },
        ];
      if (c.collection === 'tickets' && !c.aggregate)
        return ids.map((id) => ({ id, status: 'open', assigned_agent: null, date_created: null }));
      if (c.collection === 'directus_revisions')
        return [
          // Newest first, as asked for.
          {
            item: 't5',
            activity: { action: 'update', timestamp: '2026-09-20T10:00:00Z', user: 'u2' },
          },
          {
            item: 't5',
            activity: { action: 'update', timestamp: '2026-09-10T10:00:00Z', user: 'u1' },
          },
        ];
      return [];
    };
    const data = await load('complaints');

    // 300 tickets used to be three chunked requests by id; it is one now,
    // asking only for human updates rather than every revision there is.
    const revs = reads('directus_revisions');
    expect(revs).toHaveLength(1);
    const filter = JSON.stringify(revs[0]!.opts.filter);
    expect(filter).not.toContain('"item"');
    expect(filter).toContain('"update"');
    expect(filter).toContain('"_nnull"');
    expect(data.complaints.find((r) => r.id === 't5')?.lastModifiedBy).toBe('Bob');
  });

  it('counts the tickets logged outside the window on the server, with their date span', async () => {
    answer = (c) =>
      c.collection === 'tickets' && c.aggregate
        ? [
            {
              count: '7646',
              min: { complaint_date: '2023-12-31T23:27:00.000Z' },
              max: { complaint_date: '2026-09-04T23:40:00.000Z' },
            },
          ]
        : [];
    const data = await load('complaints');
    expect(data.loggedOutsideWindow).toEqual({
      count: 7646,
      earliest: '2023-12-31',
      latest: '2026-09-04',
    });
  });
});

describe('one batch, not a queue', () => {
  it('asks for routing, revisions and the outside count before the tickets come back', async () => {
    // Nothing answers until released: every request made by then was made
    // WITHOUT waiting for another one.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    request.mockImplementation(async () => {
      await gate;
      return [];
    });
    const { result } = renderHook(
      () => useAgentReportData(0, labels, { from: '2026-09-01', to: '2026-09-30' }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(reads('tickets').length).toBeGreaterThan(0));
    await waitFor(() => {
      expect(reads('routing_events')).toHaveLength(1);
      expect(reads('directus_revisions')).toHaveLength(1);
      expect(aggregates('tickets')).toHaveLength(1);
    });
    release();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
