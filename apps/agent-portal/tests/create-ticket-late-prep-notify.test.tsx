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
      storeNotifyTypes: [],
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

  it('any other type still needs its rule', async () => {
    const out = await save('Order cold');
    expect(out.storeNotify).toBe('type-not-notifying');
    expect(calls().some((c) => c.collection === 'store_notifications')).toBe(false);
  });
});
