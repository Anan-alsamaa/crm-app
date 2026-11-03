import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('@directus/sdk', async (orig) => ({
  ...(await orig<typeof import('@directus/sdk')>()),
  createItem: (collection: string, item: unknown) => ({ collection, item }),
}));

import { useCreateTicketFromConversation } from '../src/features/tickets/api.js';

/**
 * LATE PREPARATION ALWAYS TELLS THE BRANCH (owner, 2026-10-29): a ticket of
 * type "Instore preparation late order" raised from Add ticket - manually or
 * from a chat, one path for both - queues its branch notification even when
 * operations switched no type on under Branch notifications.
 */
function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const calls = () =>
  request.mock.calls.map((c) => c[0] as { collection: string; item: Record<string, unknown> });

beforeEach(() => {
  request.mockClear();
  request.mockImplementation(async (arg: { collection: string }) =>
    arg.collection === 'tickets' ? { id: 'tk1' } : {},
  );
});

async function save(complaintType: string) {
  const { result } = renderHook(() => useCreateTicketFromConversation(), { wrapper: wrapper() });
  let out: { storeNotify?: string } | undefined;
  await waitFor(async () => {
    out = (await result.current.mutateAsync({
      ticket: {
        subject: complaintType,
        complaint_type: complaintType,
        description: 'Kitchen was late with the order.',
        store: 'store-1',
        order_id: '1339586',
      } as never,
    })) as { storeNotify?: string };
  });
  return out!;
}

describe('Add ticket - late preparation', () => {
  it('queues the branch notification with no rule switched on', async () => {
    const out = await save('Instore preparation late order');
    expect(out.storeNotify).toBe('queued');
    const n = calls().find((c) => c.collection === 'store_notifications');
    expect(n?.item).toMatchObject({
      ticket: 'tk1',
      store: 'store-1',
      complaint_type: 'Instore preparation late order',
      order_id: '1339586',
      status: 'queued',
    });
  });
});

/**
 * EVERY TICKET TYPE TELLS THE BRANCH except Driver attitude, Late driver,
 * Technical issue and Other (owner, 2026-11-03) - no rule needs switching on.
 */
describe('Add ticket - which types tell the branch', () => {
  const NOTIFY = [
    'Accuracy',
    'Cleanness',
    'Foreign object found',
    'Hospitality',
    'Instore preparation late order',
    'Late order',
    'Missing condiments',
    'Missing item',
    'Product',
    'Roach found',
    'Wrong order',
  ];
  for (const type of NOTIFY)
    it(`${type}: the branch is told, about the right ticket and branch`, async () => {
      const out = await save(type);
      expect(out.storeNotify).toBe('queued');
      const sent = calls().filter((c) => c.collection === 'store_notifications');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.item).toMatchObject({
        ticket: 'tk1',
        store: 'store-1',
        complaint_type: type,
        order_id: '1339586',
        status: 'queued',
      });
    });

  for (const type of ['Driver attitude', 'Late driver', 'Technical issue', 'Other', ' other '])
    it(`${type.trim()}: the branch is NOT told`, async () => {
      const out = await save(type);
      expect(out.storeNotify).toBe('type-not-notifying');
      expect(calls().some((c) => c.collection === 'store_notifications')).toBe(false);
    });

  it('a type added to the list later tells the branch', async () => {
    expect((await save('Packaging damaged')).storeNotify).toBe('queued');
  });

  it('no branch attached: nothing is sent, and the agent is told why', async () => {
    const { result } = renderHook(() => useCreateTicketFromConversation(), { wrapper: wrapper() });
    await expect(
      result.current.mutateAsync({
        ticket: { subject: 'Missing item', complaint_type: 'Missing item', store: null } as never,
      }),
    ).rejects.toThrow(/needs a branch/);
    expect(calls().some((c) => c.collection === 'store_notifications')).toBe(false);
  });
});
