import { io, type Socket } from 'socket.io-client';

/**
 * Widget socket connection (T051). Connects to the gateway with the Yiji JWT,
 * with automatic reconnect + exponential backoff (handled by Socket.IO's
 * reconnection, tuned here).
 */
export interface WidgetMessage {
  id: string;
  conversationId: string;
  senderType: 'customer' | 'agent' | 'system';
  content: string;
  attachments: string[];
  createdAt: string;
  clientMsgId?: string;
}

export interface SocketCallbacks {
  onReady: (info: { conversationId: string; branding: unknown }) => void;
  onMessage: (msg: WidgetMessage) => void;
  onTyping: (isTyping: boolean) => void;
  onStatus: (status: 'connecting' | 'connected' | 'reconnecting' | 'error') => void;
}

export function connectWidget(url: string, token: string, cb: SocketCallbacks): Socket {
  const socket = io(url, {
    auth: { kind: 'customer', token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
  });

  cb.onStatus('connecting');
  socket.on('connect', () => cb.onStatus('connected'));
  socket.io.on('reconnect_attempt', () => cb.onStatus('reconnecting'));
  socket.on('connect_error', () => cb.onStatus('error'));
  socket.on('ready', (info: { conversationId: string; branding: unknown }) => cb.onReady(info));
  socket.on('message:new', (msg: WidgetMessage) => cb.onMessage(msg));
  socket.on('typing:update', (e: { isTyping: boolean; who: string }) => {
    if (e.who === 'agent') cb.onTyping(e.isTyping);
  });
  return socket;
}
