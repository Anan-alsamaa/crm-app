import { describe, it, expect, vi, beforeEach } from 'vitest';

// io() returns a fake socket we control. getToken supplies a canned token.
const { ioMock, getToken } = vi.hoisted(() => ({
  ioMock: vi.fn(),
  getToken: vi.fn(),
}));
vi.mock('socket.io-client', () => ({ io: ioMock }));
vi.mock('../src/lib/directus.js', () => ({ auth: { getToken } }));

import { getSocket, disconnectSocket } from '../src/lib/socket.js';

function makeSocket(connected: boolean) {
  return {
    connected,
    emit: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
  };
}

beforeEach(() => {
  ioMock.mockReset();
  getToken.mockReset();
  getToken.mockResolvedValue('tok-123');
  (globalThis as { __yijiAgentSocket?: unknown }).__yijiAgentSocket = undefined;
  vi.useRealTimers();
});

describe('agent socket singleton', () => {
  it('supplies a freshly-fetched token via an auth callback on each connection', async () => {
    const sock = makeSocket(false);
    ioMock.mockReturnValue(sock);
    const result = await getSocket();
    expect(result).toBe(sock);
    expect(ioMock).toHaveBeenCalledTimes(1);
    const [, opts] = ioMock.mock.calls[0]!;
    // `auth` is a function (not a static object) so socket.io re-fetches the
    // token before every (re)connect — a reconnect after token expiry self-heals.
    expect(typeof opts.auth).toBe('function');
    const received = await new Promise((resolve) => opts.auth(resolve));
    expect(received).toEqual({ kind: 'agent', token: 'tok-123' });
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('omits the token when none is available so the gateway reports session expiry', async () => {
    getToken.mockResolvedValue(null);
    const sock = makeSocket(false);
    ioMock.mockReturnValue(sock);
    await getSocket();
    const [, opts] = ioMock.mock.calls[0]!;
    const received = await new Promise((resolve) => opts.auth(resolve));
    expect(received).toEqual({ kind: 'agent', token: undefined });
  });

  it('reuses an already-connected socket without reconnecting', async () => {
    const sock = makeSocket(true);
    (globalThis as { __yijiAgentSocket?: unknown }).__yijiAgentSocket = sock;
    const result = await getSocket();
    expect(result).toBe(sock);
    expect(ioMock).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it('emits agent logout and clears the global reference on disconnect', () => {
    const sock = makeSocket(true);
    (globalThis as { __yijiAgentSocket?: unknown }).__yijiAgentSocket = sock;
    disconnectSocket();
    expect(sock.emit).toHaveBeenCalled();
    expect((globalThis as { __yijiAgentSocket?: unknown }).__yijiAgentSocket).toBeUndefined();
  });

  it('disconnect is a no-op when there is no socket', () => {
    (globalThis as { __yijiAgentSocket?: unknown }).__yijiAgentSocket = undefined;
    expect(() => disconnectSocket()).not.toThrow();
  });

  it('schedules a deferred disconnect fallback', () => {
    vi.useFakeTimers();
    const sock = makeSocket(true);
    (globalThis as { __yijiAgentSocket?: unknown }).__yijiAgentSocket = sock;
    disconnectSocket();
    expect(sock.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
