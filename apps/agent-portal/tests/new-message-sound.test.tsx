import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@yiji/shared-types', () => ({
  SOCKET_EVENTS: { inboxActivity: 'inbox:activity' },
}));

const socketApi = vi.hoisted(() => ({ getSocket: vi.fn() }));
vi.mock('../src/lib/socket.js', () => socketApi);

const sound = vi.hoisted(() => ({ playMessageBeep: vi.fn() }));
vi.mock('../src/lib/sound.js', () => sound);

import { NewMessageSound } from '../src/components/NewMessageSound.js';

/** Minimal socket double capturing on/off handlers by event name. */
function makeSocket() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return {
    on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
      handlers.set(event, cb);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
    emit(event: string) {
      handlers.get(event)?.();
    },
    handlers,
  };
}

beforeEach(() => {
  socketApi.getSocket.mockReset();
  sound.playMessageBeep.mockReset();
});

describe('NewMessageSound', () => {
  it('renders nothing', () => {
    socketApi.getSocket.mockResolvedValue(makeSocket());
    const { container } = render(<NewMessageSound />);
    expect(container.firstChild).toBeNull();
  });

  it('subscribes to inbox activity and beeps on each event', async () => {
    const socket = makeSocket();
    socketApi.getSocket.mockResolvedValue(socket);
    render(<NewMessageSound />);
    await waitFor(() =>
      expect(socket.on).toHaveBeenCalledWith('inbox:activity', expect.any(Function)),
    );
    socket.emit('inbox:activity');
    socket.emit('inbox:activity');
    expect(sound.playMessageBeep).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes on unmount', async () => {
    const socket = makeSocket();
    socketApi.getSocket.mockResolvedValue(socket);
    const { unmount } = render(<NewMessageSound />);
    await waitFor(() => expect(socket.on).toHaveBeenCalled());
    unmount();
    expect(socket.off).toHaveBeenCalledWith('inbox:activity', expect.any(Function));
  });

  it('skips subscribing when unmounted before the socket resolves', async () => {
    let resolveSocket!: (s: ReturnType<typeof makeSocket>) => void;
    const socket = makeSocket();
    socketApi.getSocket.mockReturnValue(
      new Promise<ReturnType<typeof makeSocket>>((res) => {
        resolveSocket = res;
      }),
    );
    const { unmount } = render(<NewMessageSound />);
    unmount(); // cancel before the socket promise settles
    resolveSocket(socket);
    // Give the pending microtask a chance to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.on).not.toHaveBeenCalled();
  });
});
