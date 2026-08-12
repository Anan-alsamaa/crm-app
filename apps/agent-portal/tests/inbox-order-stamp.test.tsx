import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('@directus/sdk', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // Echo the call so the assertion can read what was written/queried.
    readItems: (collection: string, query: unknown) => ({ kind: 'read', collection, query }),
    updateItem: (collection: string, id: string, patch: unknown) => ({
      kind: 'update',
      collection,
      id,
      patch,
    }),
  };
});

const commerceMock = vi.hoisted(() => ({ getInboxOrders: vi.fn() }));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce: commerceMock }));

import {
  inboxOrdersKey,
  useConversations,
  usePrefetchInboxOrders,
  useStampConversationOrder,
} from '../src/features/inbox/api.js';

function wrapper(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const W = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { W, qc };
}

const order = { orderId: '946641', status: 'delivered', total: 42, currency: 'SAR' };

beforeEach(() => {
  request.mockReset();
  commerceMock.getInboxOrders.mockReset();
  commerceMock.getInboxOrders.mockResolvedValue({ orders: [order], detail: order });
});

describe('order-id search', () => {
  it('matches the order stamped on the conversation, not only a ticket', async () => {
    // This is the fix: an agent searching "946641" is usually looking for the
    // chat in order to RAISE a ticket, so a filter that only knows about
    // existing tickets finds nothing exactly when it is needed.
    request.mockResolvedValueOnce([]);
    const { W } = wrapper();
    renderHook(() => useConversations({ search: '946641' }), { wrapper: W });
    await waitFor(() => expect(request).toHaveBeenCalled());

    const query = (request.mock.calls[0]![0] as { query: { filter: unknown } }).query;
    const or = (query.filter as { _and: Array<{ _or?: unknown[] }> })._and.find((c) => c._or)!._or!;
    expect(or).toContainEqual({ last_order_id: { _contains: '946641' } });
  });

  it('does not ask for an order id when the term has no digits', async () => {
    request.mockResolvedValueOnce([]);
    const { W } = wrapper();
    renderHook(() => useConversations({ search: 'alice' }), { wrapper: W });
    await waitFor(() => expect(request).toHaveBeenCalled());

    const query = (request.mock.calls[0]![0] as { query: { filter: unknown } }).query;
    const or = (query.filter as { _and: Array<{ _or?: unknown[] }> })._and.find((c) => c._or)!._or!;
    expect(JSON.stringify(or)).not.toContain('last_order_id');
  });
});

describe('useStampConversationOrder', () => {
  it('records the order on the conversation so it can be found later', async () => {
    request.mockResolvedValue({});
    const { W } = wrapper();
    const { result } = renderHook(() => useStampConversationOrder(), { wrapper: W });
    result.current('c1', order as never);

    await waitFor(() => expect(request).toHaveBeenCalled());
    const call = request.mock.calls[0]![0] as {
      collection: string;
      id: string;
      patch: Record<string, unknown>;
    };
    expect(call.collection).toBe('conversations');
    expect(call.id).toBe('c1');
    expect(call.patch.last_order_id).toBe('946641');
    expect(call.patch.last_order_snapshot).toEqual(order);
  });

  it('does not rewrite the same order every time the chat is opened', async () => {
    request.mockResolvedValue({});
    const { W } = wrapper();
    const { result } = renderHook(() => useStampConversationOrder(), { wrapper: W });
    result.current('c1', order as never);
    result.current('c1', order as never);
    result.current('c1', order as never);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });

  it('writes again when the customer has ordered since', async () => {
    request.mockResolvedValue({});
    const { W } = wrapper();
    const { result } = renderHook(() => useStampConversationOrder(), { wrapper: W });
    result.current('c1', order as never);
    result.current('c1', { ...order, orderId: '946999' } as never);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('lets a failed stamp be retried rather than remembering a lie', async () => {
    request.mockRejectedValueOnce(new Error('403'));
    const { W } = wrapper();
    const { result } = renderHook(() => useStampConversationOrder(), { wrapper: W });
    result.current('c1', order as never);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    request.mockResolvedValue({});
    result.current('c1', order as never);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
});

describe('usePrefetchInboxOrders', () => {
  const conversation = {
    id: 'c1',
    contact: { id: 'k1', external_customer_id: 'cust-1', vendor: { id: 'v', yiji_vendor_id: '1' } },
  };

  it('warms the exact key the panel will read, before the click', async () => {
    const { W, qc } = wrapper();
    const { result } = renderHook(() => usePrefetchInboxOrders(), { wrapper: W });
    result.current(conversation as never);

    await waitFor(() =>
      expect(qc.getQueryData(inboxOrdersKey('1', 'cust-1'))).toEqual({
        orders: [order],
        detail: order,
      }),
    );
  });

  it('does nothing for a contact with no commerce customer behind it', () => {
    const { W } = wrapper();
    const { result } = renderHook(() => usePrefetchInboxOrders(), { wrapper: W });
    result.current({ id: 'c2', contact: { id: 'k2' } } as never);
    expect(commerceMock.getInboxOrders).not.toHaveBeenCalled();
  });

  it('does not refetch while the answer is still fresh', async () => {
    const { W } = wrapper();
    const { result } = renderHook(() => usePrefetchInboxOrders(), { wrapper: W });
    result.current(conversation as never);
    await waitFor(() => expect(commerceMock.getInboxOrders).toHaveBeenCalledTimes(1));
    // Sweeping the pointer down the list must not fan out into a request storm.
    result.current(conversation as never);
    result.current(conversation as never);
    expect(commerceMock.getInboxOrders).toHaveBeenCalledTimes(1);
  });
});
