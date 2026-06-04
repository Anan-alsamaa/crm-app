import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS } from '@yiji/shared-types';
import { auth } from './directus.js';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:8080';

/**
 * The agent gateway socket is a SINGLETON across the whole app — every page
 * that needs realtime (inbox, conversation view, notification bell, …) calls
 * `getSocket()` and shares one connection.
 *
 * Why we stash it on `globalThis` rather than a module-level `let`:
 * Vite hot-reloads modules on every save during dev. A module-level singleton
 * vanishes when the module is replaced — the new module instance starts fresh
 * with no reference to the previously-opened socket, while the OLD socket is
 * still happily connected to the gateway. A subsequent `disconnectSocket()`
 * call would then no-op on the new module's `null` ref, and the gateway would
 * only notice the agent went away when its Engine.IO heartbeat timed out
 * (~25–45s later). That's exactly the "must reload :5173 before :5175 shows
 * offline" symptom. Hoisting to `globalThis` survives HMR; the matching
 * `import.meta.hot.dispose` below disconnects cleanly when the module is
 * about to be replaced so a fresh `getSocket()` mints a real new connection.
 */
declare global {
  // eslint-disable-next-line no-var
  var __yijiAgentSocket: Socket | undefined;
}

/** Connect the agent socket using the current Directus access token. */
export async function getSocket(): Promise<Socket> {
  if (globalThis.__yijiAgentSocket?.connected) return globalThis.__yijiAgentSocket;
  const token = await auth.getToken();
  globalThis.__yijiAgentSocket = io(SOCKET_URL, {
    auth: { kind: 'agent', token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
  });
  return globalThis.__yijiAgentSocket;
}

export function disconnectSocket(): void {
  const s = globalThis.__yijiAgentSocket;
  // Drop the global reference first so any subsequent getSocket() call
  // mints a fresh connection rather than handing back this stale one.
  globalThis.__yijiAgentSocket = undefined;
  if (!s) return;
  try {
    if (s.connected) s.emit(SOCKET_EVENTS.agentLogout);
  } catch {
    // Best-effort — if emit throws (socket already half-torn) the fallback
    // below still runs.
  }
  // Socket.IO gotcha (documented): calling disconnect() immediately after
  // emit() can tear the transport down before the in-flight packet is
  // flushed, so the server never receives agent:logout. The gateway's
  // handler disconnects us anyway after processing the event, so we just
  // need a short-deferred local disconnect as a fallback for the case
  // where the server never processes the emit (network drop, gateway
  // bounce mid-flight). 500ms is plenty for the packet to leave on a
  // healthy connection.
  setTimeout(() => {
    if (s.connected) s.disconnect();
  }, 500);
}

// Vite HMR: when this module is about to be replaced, kill the old socket
// first so we don't leak a connection. In production this branch is dead
// code (import.meta.hot is undefined) and gets tree-shaken.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    globalThis.__yijiAgentSocket?.disconnect();
    globalThis.__yijiAgentSocket = undefined;
  });
}
