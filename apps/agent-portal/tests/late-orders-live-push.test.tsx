import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { SOCKET_EVENTS } from '@yiji/shared-types';

/**
 * OPTION 2 (owner, 2026-10-12): the workers poll Yiji once a minute and the
 * socket-gateway pushes `late-orders:changed`; an open Late orders page
 * refetches TODAY'S queue on that push (debounced), not on a fast timer.
 */
const handlers = vi.hoisted(() => new Map<string, Set<() => void>>());
const fakeSocket = vi.hoisted(() => ({
  on: (ev: string, fn: () => void) => {
    if (!handlers.has(ev)) handlers.set(ev, new Set());
    handlers.get(ev)!.add(fn);
  },
  off: (ev: string, fn: () => void) => {
    handlers.get(ev)?.delete(fn);
  },
}));
vi.mock('../src/lib/socket.js', () => ({ getSocket: vi.fn(async () => fakeSocket) }));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce: {} }));
vi.mock('../src/lib/directus.js', () => ({ directus: {} }));

import {
  useLateOrdersPush,
  isLiveLateOrdersQuery,
  LATE_ORDERS_PUSH_DEBOUNCE_MS,
} from '../src/features/late-orders/live-push.js';

const fire = (ev: string) => handlers.get(ev)?.forEach((fn) => fn());
const listeners = (ev: string) => handlers.get(ev)?.size ?? 0;

function setup(enabled: boolean) {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const hook = renderHook(({ on }) => useLateOrdersPush(on), {
    wrapper,
    initialProps: { on: enabled },
  });
  return { spy, hook };
}

/** Let the async getSocket() inside the effect resolve. */
const flush = () => act(async () => {});

describe('late orders: refetch on the server push', () => {
  beforeEach(() => {
    handlers.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('invalidates the live queue once for a burst of pushes', async () => {
    const { spy } = setup(true);
    await flush();
    expect(listeners(SOCKET_EVENTS.lateOrdersChanged)).toBe(1);
    fire(SOCKET_EVENTS.lateOrdersChanged);
    fire(SOCKET_EVENTS.lateOrdersChanged);
    expect(spy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(LATE_ORDERS_PUSH_DEBOUNCE_MS));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ predicate: isLiveLateOrdersQuery });
  });

  it('refetches on a reconnect - a dropped socket missed the pushes', async () => {
    const { spy } = setup(true);
    await flush();
    fire('connect');
    act(() => vi.advanceTimersByTime(LATE_ORDERS_PUSH_DEBOUNCE_MS));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not listen while a past range is shown, and stops listening on unmount', async () => {
    const off = setup(false);
    await flush();
    expect(listeners(SOCKET_EVENTS.lateOrdersChanged)).toBe(0);
    off.hook.unmount();

    const on = setup(true);
    await flush();
    expect(listeners(SOCKET_EVENTS.lateOrdersChanged)).toBe(1);
    on.hook.unmount();
    expect(listeners(SOCKET_EVENTS.lateOrdersChanged)).toBe(0);
    expect(listeners('connect')).toBe(0);
  });

  it("touches only today's live queue, never the decisions or a history range", () => {
    expect(
      isLiveLateOrdersQuery({ queryKey: ['late-orders', '2026-10-12', '2026-10-12', 'live'] }),
    ).toBe(true);
    expect(
      isLiveLateOrdersQuery({
        queryKey: ['late-orders', '2026-10-12', '2026-10-12', 'live', 'v2'],
      }),
    ).toBe(true);
    expect(
      isLiveLateOrdersQuery({ queryKey: ['late-orders', '2026-10-01', '2026-10-03', 'hist'] }),
    ).toBe(false);
    expect(isLiveLateOrdersQuery({ queryKey: ['late-orders', 'decisions', null, null] })).toBe(
      false,
    );
  });

  it('is wired into the page for whenever today is on screen', () => {
    const page = readFileSync(
      resolve(__dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/useLateOrdersPush\(showingToday\);/);
  });
});
