import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/*
 * A RECONNECT MEANS WE MISSED SOMETHING.
 *
 * `inbox:activity` is a live push. An agent whose socket was down when a
 * customer wrote never receives it — and nothing ever tells them. The socket
 * reconnects perfectly (token refreshed, rooms rejoined) and the inbox stays
 * frozen on whatever it held before the drop. The chat sits in the database,
 * assigned to them, waiting, and invisible.
 *
 * Reported on 2026-09-16: a customer message reached no agent for a full
 * minute, surfacing only when the 60-second routing ladder fired and moved the
 * chat on. The gateway was being replaced by a deploy at the time, so every
 * agent's websocket had just been dropped — but the same gap opens for a
 * laptop that sleeps, a lift, or hotel wifi.
 *
 * What is pinned here is the CONTRACT, not the page: a socket that connects
 * must refetch. Socket.IO fires `connect` on the first connection as well as
 * every reconnection, so this covers both.
 */

const socket = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    on: vi.fn((ev: string, fn: (...a: unknown[]) => void) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    }),
    off: vi.fn(),
    emit: vi.fn(),
    handlers,
    /** Pretend the gateway came back. */
    fire(ev: string) {
      for (const fn of handlers.get(ev) ?? []) fn();
    },
  };
});
vi.mock('../src/lib/socket.js', () => ({
  getSocket: async () => socket,
  onSocketSessionExpired: () => undefined,
}));

/**
 * The subscription exactly as the inbox wires it. Kept here rather than
 * rendering the whole page: the page needs a router, an auth provider and a
 * dozen queries, none of which are what this is about.
 */
function useInboxSubscription(qc: QueryClient) {
  React.useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const s = await (await import('../src/lib/socket.js')).getSocket();
      if (cancelled) return;
      const onActivity = () => {
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        void qc.invalidateQueries({ queryKey: ['conversation-previews'] });
      };
      s.on('inbox:activity', onActivity);
      s.on('connect', onActivity);
      cleanup = () => {
        s.off('inbox:activity', onActivity);
        s.off('connect', onActivity);
      };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [qc]);
}

function Harness({ qc }: { qc: QueryClient }) {
  useInboxSubscription(qc);
  return null;
}

beforeEach(() => {
  socket.handlers.clear();
  socket.on.mockClear();
});

describe('the inbox after a dropped socket', () => {
  const setup = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    render(<Harness qc={qc} />, { wrapper });
    return { qc, invalidate };
  };

  it('listens for the reconnect, not only for live activity', async () => {
    setup();
    await waitFor(() => expect(socket.handlers.has('connect')).toBe(true));
    expect(socket.handlers.has('inbox:activity')).toBe(true);
  });

  it('REFETCHES when the socket reconnects', async () => {
    const { invalidate } = setup();
    await waitFor(() => expect(socket.handlers.has('connect')).toBe(true));
    invalidate.mockClear();

    socket.fire('connect');

    // Both lists: the conversation rows AND the last-message previews, or the
    // inbox shows a chat whose preview is a minute stale.
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversation-previews'] });
    });
  });

  it('still refetches on ordinary live activity', async () => {
    // The reconnect handler must not have displaced the normal path.
    const { invalidate } = setup();
    await waitFor(() => expect(socket.handlers.has('inbox:activity')).toBe(true));
    invalidate.mockClear();

    socket.fire('inbox:activity');

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations'] }));
  });
});
