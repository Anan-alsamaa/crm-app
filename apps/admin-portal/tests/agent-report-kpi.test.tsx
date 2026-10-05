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
const agentMsg = (conversation: string, t: string, by: string | null) => ({
  conversation,
  sender_type: 'agent',
  date_created: at(t),
  sender_user: by,
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
      agentMsg('c4', '10:00:30', null),
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
