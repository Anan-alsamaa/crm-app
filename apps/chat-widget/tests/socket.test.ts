import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SocketCallbacks, WidgetMessage } from '../src/socket.js';

// io() returns a fake socket we control. We record every handler registered via
// socket.on / socket.io.on so tests can drive incoming events by invoking them.
const { ioMock } = vi.hoisted(() => ({ ioMock: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: ioMock }));

import { connectWidget } from '../src/socket.js';

type Handler = (...args: unknown[]) => void;

interface FakeSocket {
  handlers: Map<string, Handler>;
  ioHandlers: Map<string, Handler>;
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  io: { on: ReturnType<typeof vi.fn> };
  /** trigger a socket-level event */
  fire: (event: string, ...args: unknown[]) => void;
  /** trigger a manager (socket.io) level event */
  fireIo: (event: string, ...args: unknown[]) => void;
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, Handler>();
  const ioHandlers = new Map<string, Handler>();
  const sock: FakeSocket = {
    handlers,
    ioHandlers,
    on: vi.fn((event: string, fn: Handler) => {
      handlers.set(event, fn);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    io: {
      on: vi.fn((event: string, fn: Handler) => {
        ioHandlers.set(event, fn);
      }),
    },
    fire: (event, ...args) => handlers.get(event)?.(...args),
    fireIo: (event, ...args) => ioHandlers.get(event)?.(...args),
  };
  return sock;
}

function makeCallbacks(): SocketCallbacks & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onReady: vi.fn(),
    onMessage: vi.fn(),
    onHistory: vi.fn(),
    onTyping: vi.fn(),
    onStatus: vi.fn(),
    onAgentsPresence: vi.fn(),
    onClosed: vi.fn(),
  } as unknown as SocketCallbacks & Record<string, ReturnType<typeof vi.fn>>;
}

let sock: FakeSocket;

beforeEach(() => {
  ioMock.mockReset();
  sock = makeSocket();
  ioMock.mockReturnValue(sock);
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connectWidget — connection setup', () => {
  it('connects with the customer auth kind + token and returns the socket', () => {
    const cb = makeCallbacks();
    const result = connectWidget('https://gw.example', 'tok-abc', cb);

    expect(result).toBe(sock);
    expect(ioMock).toHaveBeenCalledTimes(1);
    const [url, opts] = ioMock.mock.calls[0]!;
    expect(url).toBe('https://gw.example');
    expect(opts.auth).toEqual({ kind: 'customer', token: 'tok-abc' });
    expect(opts.transports).toEqual(['websocket', 'polling']);
    expect(opts.reconnection).toBe(true);
    expect(opts.extraHeaders).toEqual({ 'ngrok-skip-browser-warning': 'true' });
  });

  it('reports "connecting" synchronously before any socket event fires', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    expect(cb.onStatus).toHaveBeenCalledWith('connecting');
  });

  it('registers all expected socket + manager handlers', () => {
    connectWidget('u', 't', makeCallbacks());
    for (const ev of [
      'connect',
      'connect_error',
      'ready',
      'message:new',
      'messages:history',
      'typing:update',
      'agents:presence',
      'conversation:closed',
    ]) {
      expect(sock.handlers.has(ev)).toBe(true);
    }
    expect(sock.ioHandlers.has('reconnect_attempt')).toBe(true);
  });
});

describe('connectWidget — status transitions', () => {
  it('reports "connected" on connect', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    sock.fire('connect');
    expect(cb.onStatus).toHaveBeenCalledWith('connected');
  });

  it('reports "reconnecting" on the manager reconnect_attempt', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    sock.fireIo('reconnect_attempt');
    expect(cb.onStatus).toHaveBeenCalledWith('reconnecting');
  });

  it('reports "error" on connect_error', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    sock.fire('connect_error', new Error('boom'));
    expect(cb.onStatus).toHaveBeenCalledWith('error');
  });
});

describe('connectWidget — connect_error reload heuristics', () => {
  const origLocation = window.location;

  beforeEach(() => {
    // Replace window.location with a reload spy.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, reload: vi.fn() },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: origLocation,
    });
  });

  it('reloads on an auth error that happens after the 30s grace window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    // Advance past the 30s grace window so a mid-session token expiry self-heals.
    vi.setSystemTime(31_000);
    sock.fire('connect_error', new Error('jwt expired'));
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('does NOT reload for an auth error inside the grace window (bad-at-startup token)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    vi.setSystemTime(5_000);
    sock.fire('connect_error', new Error('unauthorized'));
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(cb.onStatus).toHaveBeenCalledWith('error');
  });

  it('does NOT reload for a non-auth error even past the grace window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    vi.setSystemTime(60_000);
    sock.fire('connect_error', new Error('network down'));
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('matches the "inactive vendor" auth phrase', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    vi.setSystemTime(40_000);
    sock.fire('connect_error', new Error('Inactive vendor'));
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });
});

describe('connectWidget — incoming event dispatch', () => {
  it('maps ready and defaults agentsOnline to 0 when omitted', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    sock.fire('ready', { conversationId: 'c1', branding: { a: 1 } });
    expect(cb.onReady).toHaveBeenCalledWith({
      conversationId: 'c1',
      branding: { a: 1 },
      agentsOnline: 0,
    });
  });

  it('passes through agentsOnline + contact + isNew on ready', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    const info = {
      conversationId: 'c2',
      branding: null,
      agentsOnline: 3,
      contact: { name: 'Ada', phone: '123' },
      isNew: true,
    };
    sock.fire('ready', info);
    expect(cb.onReady).toHaveBeenCalledWith(info);
  });

  it('forwards message:new to onMessage', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    const msg: WidgetMessage = {
      id: 'm1',
      conversationId: 'c1',
      senderType: 'agent',
      content: 'hi',
      attachments: [],
      createdAt: '2026-01-01',
    };
    sock.fire('message:new', msg);
    expect(cb.onMessage).toHaveBeenCalledWith(msg);
  });

  it('normalizes messages:history entries (fills missing attachments + conversationId)', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    sock.fire('messages:history', {
      conversationId: 'c9',
      messages: [
        { id: 'a', senderType: 'customer', content: 'q', createdAt: 't1' },
        {
          id: 'b',
          senderType: 'agent',
          content: 'r',
          createdAt: 't2',
          attachments: ['f1'],
        },
      ],
    });
    expect(cb.onHistory).toHaveBeenCalledWith([
      {
        id: 'a',
        conversationId: 'c9',
        senderType: 'customer',
        content: 'q',
        attachments: [],
        createdAt: 't1',
      },
      {
        id: 'b',
        conversationId: 'c9',
        senderType: 'agent',
        content: 'r',
        attachments: ['f1'],
        createdAt: 't2',
      },
    ]);
  });

  it('does not throw on messages:history when onHistory is not provided', () => {
    const cb = makeCallbacks();
    delete (cb as Record<string, unknown>).onHistory;
    connectWidget('u', 't', cb);
    expect(() =>
      sock.fire('messages:history', { conversationId: 'c', messages: [] }),
    ).not.toThrow();
  });

  it('forwards agent typing but ignores non-agent typing', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    sock.fire('typing:update', { isTyping: true, who: 'agent' });
    expect(cb.onTyping).toHaveBeenCalledWith(true);

    cb.onTyping.mockClear();
    sock.fire('typing:update', { isTyping: true, who: 'customer' });
    expect(cb.onTyping).not.toHaveBeenCalled();
  });

  it('forwards agents:presence count', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    sock.fire('agents:presence', { count: 5 });
    expect(cb.onAgentsPresence).toHaveBeenCalledWith(5);
  });

  it('does not throw on agents:presence when onAgentsPresence is absent', () => {
    const cb = makeCallbacks();
    delete (cb as Record<string, unknown>).onAgentsPresence;
    connectWidget('u', 't', cb);
    expect(() => sock.fire('agents:presence', { count: 1 })).not.toThrow();
  });

  it('forwards conversation:closed', () => {
    const cb = makeCallbacks();
    connectWidget('u', 't', cb);
    const e = { conversationId: 'c1', status: 'resolved' as const };
    sock.fire('conversation:closed', e);
    expect(cb.onClosed).toHaveBeenCalledWith(e);
  });

  it('does not throw on conversation:closed when onClosed is absent', () => {
    const cb = makeCallbacks();
    delete (cb as Record<string, unknown>).onClosed;
    connectWidget('u', 't', cb);
    expect(() =>
      sock.fire('conversation:closed', { conversationId: 'c', status: 'closed' }),
    ).not.toThrow();
  });
});
