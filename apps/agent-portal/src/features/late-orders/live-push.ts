import { useEffect } from 'react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import { SOCKET_EVENTS } from '@yiji/shared-types';
import { getSocket } from '../../lib/socket.js';
import { LATE_ORDERS_KEY } from './api.js';

/**
 * How long a burst of pushes is collapsed into one refetch. Two vendors
 * changing in the same poll arrive as two events a few milliseconds apart;
 * the page should ask once.
 */
export const LATE_ORDERS_PUSH_DEBOUNCE_MS = 750;

/** Today's queue - the `live` query - and nothing else (not the decisions, not a history range). */
export const isLiveLateOrdersQuery = (q: Pick<Query, 'queryKey'>): boolean =>
  q.queryKey[0] === LATE_ORDERS_KEY[0] && q.queryKey[3] === 'live';

/**
 * REFETCH WHEN THE SERVER SAYS THE QUEUE CHANGED (owner, 2026-10-12).
 *
 * The workers ask Yiji for today's late orders once a minute, whatever the
 * number of screens, and the socket-gateway sends `late-orders:changed` to
 * every agent when what they would see changed. This listens while the page
 * shows today and invalidates the live queue, so a new late order (and its
 * beep and NEW tag, which work off the query result) lands within seconds of
 * the poll that found it - without each screen polling to find out.
 *
 * A reconnect refetches too: a socket that was down missed every push while it
 * was down. The slow `LATE_ORDERS_SAFETY_POLL_MS` timer covers the rest.
 *
 * The listener is registered inside an async IIFE, so its cleanup is held in a
 * variable and called from the effect's own cleanup - returning it from the
 * IIFE would hand it to a Promise and React would never call it (see
 * [[socket-listener-leak-async-iife]]).
 */
export function useLateOrdersPush(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void qc.invalidateQueries({ predicate: isLiveLateOrdersQuery });
      }, LATE_ORDERS_PUSH_DEBOUNCE_MS);
    };
    void (async () => {
      try {
        const socket = await getSocket();
        if (cancelled) return;
        socket.on(SOCKET_EVENTS.lateOrdersChanged, refresh);
        socket.on('connect', refresh);
        cleanup = () => {
          socket.off(SOCKET_EVENTS.lateOrdersChanged, refresh);
          socket.off('connect', refresh);
        };
      } catch {
        /* No socket: the safety-net poll still refreshes the page. */
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      cleanup?.();
    };
  }, [enabled, qc]);
}
