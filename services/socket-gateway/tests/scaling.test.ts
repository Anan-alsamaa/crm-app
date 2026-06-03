import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-adapter';
import RedisMock from 'ioredis-mock';
import { rooms, SOCKET_EVENTS } from '@yiji/shared-types';

/**
 * T043 (SC-010) — cross-instance routing via the Redis adapter.
 * Spins up TWO Socket.IO servers sharing an ioredis-mock pub/sub backbone (no
 * external Redis required), connects two clients (one to each instance), joins
 * both to the same conversation room, and verifies a broadcast on instance A
 * is delivered to the client connected to instance B.
 */
async function startInstance(): Promise<{
  port: number;
  io: SocketServer;
  close: () => Promise<void>;
}> {
  const httpServer = createServer();
  const io = new SocketServer(httpServer, { cors: { origin: '*' } });
  // Shared in-memory backing: every new RedisMock instance sees the same data.
  const pub = new (RedisMock as unknown as typeof import('ioredis').default)();
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    port,
    io,
    close: async () => {
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await pub.quit();
      await sub.quit();
    },
  };
}

describe('cross-instance routing via Redis adapter (T043, SC-010)', () => {
  it('delivers a room broadcast from instance A to a client on instance B', async () => {
    const room = rooms.conversation('cross-instance-test');
    const a = await startInstance();
    const b = await startInstance();

    // Each instance joins its connecting client to the shared room.
    for (const inst of [a, b]) {
      inst.io.on('connection', (s) => {
        void s.join(room);
      });
    }

    const clientA: ClientSocket = ioClient(`http://localhost:${a.port}`, {
      transports: ['websocket'],
    });
    const clientB: ClientSocket = ioClient(`http://localhost:${b.port}`, {
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise<void>((resolve) => clientA.on('connect', () => resolve())),
      new Promise<void>((resolve) => clientB.on('connect', () => resolve())),
    ]);

    // Give the adapter a moment to propagate the JOIN across instances.
    await new Promise((r) => setTimeout(r, 50));

    const received = new Promise<{ id: string }>((resolve) =>
      clientB.once(SOCKET_EVENTS.messageNew, (m: { id: string }) => resolve(m)),
    );
    a.io.to(room).emit(SOCKET_EVENTS.messageNew, { id: 'X' });

    const msg = await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('did not receive cross-instance broadcast')), 3000),
      ),
    ]);
    expect(msg.id).toBe('X');

    clientA.disconnect();
    clientB.disconnect();
    await a.close();
    await b.close();
  });
});
