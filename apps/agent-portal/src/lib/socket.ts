import { io, type Socket } from 'socket.io-client';
import { auth } from './directus.js';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:8080';

let socket: Socket | null = null;

/** Connect the agent socket using the current Directus access token. */
export async function getSocket(): Promise<Socket> {
  if (socket?.connected) return socket;
  const token = await auth.getToken();
  socket = io(SOCKET_URL, {
    auth: { kind: 'agent', token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
  });
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
