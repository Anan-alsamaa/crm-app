import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readUsers: (opts: unknown) => ({ collection: 'directus_users', opts }),
  readRevisions: (opts: unknown) => ({ collection: 'directus_revisions', opts }),
  aggregate: (collection: string, opts: unknown) => ({ collection, opts, aggregate: true }),
}));

import { useAgentReportData } from '../src/features/report-exports/api.js';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const labels = { unassigned: 'Unassigned', noSubject: '(none)' };
const at = (hhmmss: string) => `2026-09-10T${hhmmss}.000Z`;

const conv = (id: string, agent: string) => ({
  id,
  status: 'open',
  priority: 'normal',
  assigned_agent: agent,
  date_created: at('09:59:00'),
  solved_at: null,
  last_message_at: null,
  contact: null,
  last_order_id: null,
});
const customer = (conversation: string, t: string) => ({
  conversation,
  sender_type: 'customer',
  date_created: at(t),
  sender_user: null,
});
const agentMsg = (conversation: string, t: string, by: string | undefined) => ({
  conversation,
  sender_type: 'agent',
  date_created: at(t),
  /* An unknown sender is an ABSENT field, not null: since 2026-10-06 an agent
     message with an explicit null `sender_user` is the automatic welcome, which
     is no reply at all (owner, 2026-10-06). */
  ...(by === undefined ? {} : { sender_user: by }),
});

beforeEach(() => {
  request.mockReset();
  const byCollection: Record<string, unknown[]> = {
    directus_users: [
      { id: 'u1', first_name: 'Ann', last_name: null, email: 'ann@x.com' },
      { id: 'u2', first_name: 'Bob', last_name: null, email: 'bob@x.com' },
    ],
    conversations: [conv('c1', 'u1'), conv('c2', 'u1'), conv('c3', 'u1'), conv('c4', 'u1')],
    messages: [
      // Ann: one minute, two minutes, and one chat answered eight hours later.
      customer('c1', '10:00:00'),
      agentMsg('c1', '10:01:00', 'u1'),
      customer('c2', '10:00:00'),
      agentMsg('c2', '10:02:00', 'u1'),
      customer('c3', '10:00:00'),
      agentMsg('c3', '18:00:00', 'u1'),
      // Still assigned to Ann, but the ladder passed it on and BOB picked it
      // up; the reply carries no sender_user, so only the routing says who.
      customer('c4', '10:00:00'),
      agentMsg('c4', '10:00:30', undefined),
    ],
    routing_events: [{ conversation: 'c4', agent: 'u2', outcome: 'answered', stage: 'broadcast' }],
  };
  request.mockImplementation(async (q: unknown) => {
    const c = q as { collection?: string };
    return byCollection[c.collection ?? ''] ?? [];
  });
});

async function agents() {
  const { result } = renderHook(
    () => useAgentReportData(0, labels, { from: '2026-09-01', to: '2026-09-30' }),
    { wrapper: wrapper() },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data!.agents;
}

describe('Agent summary — first response (owner, 2026-10-05)', () => {
  it('reports the MEDIAN first response, which one overnight wait cannot drag', async () => {
    const ann = (await agents()).find((a) => a.agentId === 'u1')!;
    // 60 s, 120 s, 28,800 s: the median is two minutes. The mean of the same
    // three is 2 h 41 m, which is what the column used to say.
    expect(ann.medianFirstResponseSec).toBe(120);
  });

  it('credits "replied within 5 min" to the same agent the timing credits', async () => {
    const rows = await agents();
    const ann = rows.find((a) => a.agentId === 'u1')!;
    const bob = rows.find((a) => a.agentId === 'u2')!;
    // c4 is Bob's reply (taken off the ladder), so it is in HIS percentage and
    // his median — not in Ann's percentage beside Bob's time.
    expect(bob.inTimePct).toBe(100);
    expect(bob.medianFirstResponseSec).toBe(30);
    // Ann: two of her three replies inside five minutes.
    expect(ann.inTimePct).toBeCloseTo((2 / 3) * 100, 5);
  });
});

describe('Agent summary — the automatic welcome is not a reply (owner, 2026-10-06)', () => {
  /* Sent a second after the customer's first message with `sender_user` null.
     Counted, every chat would be "replied within 5 min" by nobody. */
  it('measures to the first HUMAN reply', async () => {
    request.mockImplementation(async (q: unknown) => {
      const c = q as { collection?: string };
      const byCollection: Record<string, unknown[]> = {
        directus_users: [{ id: 'u1', first_name: 'Ann', last_name: null, email: 'ann@x.com' }],
        conversations: [conv('c1', 'u1')],
        messages: [
          customer('c1', '10:00:00'),
          {
            conversation: 'c1',
            sender_type: 'agent',
            date_created: at('10:00:01'),
            sender_user: null,
          },
          agentMsg('c1', '10:20:00', 'u1'),
        ],
        routing_events: [],
      };
      return byCollection[c.collection ?? ''] ?? [];
    });
    const ann = (await agents()).find((a) => a.agentId === 'u1')!;
    expect(ann.medianFirstResponseSec).toBe(20 * 60);
    expect(ann.inTimePct).toBe(0);
  });
});

describe('Agent summary — ticket solve time (prod, 2026-10-15)', () => {
  /* A ticket logged ALREADY solved: `resolved_at` is stamped in the browser as
     the form is filled, `date_created` by the server on save, so the solve
     stamp lands BEFORE the ticket exists. Read as a backwards clock, every such
     ticket was dropped and Shatha/Amjad showed "—" with solved tickets in range. */
  it('counts a ticket resolved before it was recorded as solved in 0, not as no data', async () => {
    request.mockImplementation(async (q: unknown) => {
      const c = q as { collection?: string; aggregate?: boolean };
      if (c.collection === 'tickets') {
        if (c.aggregate) return [{ assigned_agent: 'u1', count: 3 }];
        return [
          // Shatha's shape: resolved 2m27s "before" creation.
          {
            assigned_agent: 'u1',
            date_created: '2026-10-15T11:28:42.551Z',
            resolved_at: '2026-10-15T11:26:15.396Z',
          },
          {
            assigned_agent: 'u1',
            date_created: '2026-10-15T11:34:02.662Z',
            resolved_at: '2026-10-15T11:31:37.204Z',
          },
          // An ordinary one, an hour after it was opened.
          {
            assigned_agent: 'u1',
            date_created: '2026-10-15T09:00:00.000Z',
            resolved_at: '2026-10-15T10:00:00.000Z',
          },
        ];
      }
      if (c.collection === 'directus_users')
        return [{ id: 'u1', first_name: 'Ann', last_name: null, email: 'ann@x.com' }];
      return [];
    });
    const { result } = renderHook(
      () => useAgentReportData(0, labels, { from: '2026-10-14', to: '2026-10-15' }, 'agents'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const ann = result.current.data!.agents.find((a) => a.agentId === 'u1')!;
    expect(ann.tickets).toBe(3);
    // 0, 0, 3600 -> median 0. Before the fix: only the 3600 survived.
    expect(ann.medianTicketSolveSec).toBe(0);
  });
});
