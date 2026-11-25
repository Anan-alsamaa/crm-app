import { describe, it, expect, vi } from 'vitest';
import { createPresenceStore } from '../src/presence-store.js';

/**
 * "Our agents are offline right now" — while an agent sits there idle.
 *
 * The count broadcast to customers came from a MODULE-LEVEL tracker, which is
 * per gateway process. With two tasks and one agent, every customer served by
 * the other task was told nobody was available and shown the phone/WhatsApp
 * fallback. Production runs one task today, so this was a bug waiting for the
 * day somebody scaled the service — silent, and worst at exactly the busy
 * moment that prompted the scaling.
 */
describe('cross-instance agent presence', () => {
  const fakeRedis = (members: string[]) =>
    ({
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      zscore: vi.fn().mockResolvedValue('1'),
      zcard: vi.fn().mockResolvedValue(members.length),
      zrange: vi.fn().mockResolvedValue(members),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      // `heartbeatAll` batches its re-scores through a pipeline.
      multi: vi.fn(() => {
        const chain = { zadd: vi.fn(() => chain), exec: vi.fn().mockResolvedValue([]) };
        return chain;
      }),
    }) as never;

  it('counts every agent in the shared set, not just this process', async () => {
    const store = createPresenceStore(fakeRedis(['a', 'b', 'c']));
    expect(await store.onlineCount()).toBe(3);
  });

  it('sweeps stale entries before counting, so a ghost cannot be reported online', async () => {
    /*
     * THE OPPOSITE TRAP, AND THE WORSE ONE.
     *
     * This assertion used to be `not.toHaveBeenCalled()`: counting deliberately
     * did not sweep, because the score only moved when an agent SENT a message
     * and sweeping would have counted a signed-in agent who was reading quietly
     * as offline.
     *
     * That reasoning was right about the risk and wrong about the remedy. With
     * nothing sweeping, nothing ever removes an entry whose gateway was killed
     * or replaced, so every deploy leaked a permanently "online" agent. Measured
     * on staging with ZERO agents connected: `/debug/presence` reported
     * `distinctOnline: 0` while this count returned 3, and customers were shown
     * "agents are online" with nobody there to answer — strictly worse than
     * being sent to WhatsApp, because they wait instead.
     *
     * What makes the sweep safe is `heartbeatAll`: the gateway now refreshes
     * every agent it holds a socket for, so the score means "still connected"
     * rather than "last typed", and the quiet agent this test once protected
     * keeps their entry without touching the keyboard. See the heartbeat test
     * below.
     */
    const redis = fakeRedis(['ghost-from-a-killed-task']);
    const store = createPresenceStore(redis);
    await store.onlineCount();
    expect(
      (redis as unknown as { zremrangebyscore: ReturnType<typeof vi.fn> }).zremrangebyscore,
    ).toHaveBeenCalled();
  });

  it('heartbeats the agents it is given, so a quiet one is never swept out', async () => {
    // The re-scores go through a pipeline, so the assertion has to watch the
    // pipeline's zadd rather than the client's.
    const piped = vi.fn();
    const chain = { zadd: piped, exec: vi.fn().mockResolvedValue([]) };
    chain.zadd.mockReturnValue(chain);
    const redis = {
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      zscore: vi.fn().mockResolvedValue('1'),
      zcard: vi.fn().mockResolvedValue(1),
      zrange: vi.fn().mockResolvedValue(['quiet-but-present']),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      multi: vi.fn(() => chain),
    } as never;
    const store = createPresenceStore(redis);
    await store.heartbeatAll(['quiet-but-present']);
    // Re-scored to "now" purely for holding a socket — no message required.
    expect(piped).toHaveBeenCalledWith('presence:agents', expect.any(Number), 'quiet-but-present');
  });

  /*
   * REGRESSION, production 25 Nov 2026. During the 22:23 rollout an agent
   * reconnected to the NEW gateway task, then the OLD task processed the old
   * socket's disconnect and removed them from the set. They were connected
   * and working, but the heartbeat refreshed only agents already present, so
   * nothing put them back: Ali's chat was reclaimed at 22:36 while he typed,
   * and reopened chats went to colleagues at 23:26 and 23:51.
   */
  it('a heartbeat RE-ADDS a connected agent a racing disconnect removed', async () => {
    const piped = vi.fn();
    const chain = { zadd: piped, exec: vi.fn().mockResolvedValue([]) };
    chain.zadd.mockReturnValue(chain);
    const redis = {
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      zscore: vi.fn().mockResolvedValue(null), // removed by the old task
      zcard: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue([]),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      multi: vi.fn(() => chain),
    } as never;
    const store = createPresenceStore(redis);
    await store.heartbeatAll(['still-connected-agent']);
    expect(piped).toHaveBeenCalledWith(
      'presence:agents',
      expect.any(Number),
      'still-connected-agent',
    );
  });

  it('a heartbeat touches only the agents it is given (a signed-out agent has no socket)', async () => {
    const piped = vi.fn();
    const chain = { zadd: piped, exec: vi.fn().mockResolvedValue([]) };
    chain.zadd.mockReturnValue(chain);
    const redis = {
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      zscore: vi.fn().mockResolvedValue(null),
      zcard: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue([]),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      multi: vi.fn(() => chain),
    } as never;
    const store = createPresenceStore(redis);
    await store.heartbeatAll(['connected-a']);
    expect(piped).toHaveBeenCalledTimes(1);
    expect(piped).not.toHaveBeenCalledWith('presence:agents', expect.any(Number), 'signed-out-b');
  });

  it('does nothing at all when no agents are connected', async () => {
    const redis = fakeRedis([]);
    const store = createPresenceStore(redis);
    await store.heartbeatAll([]);
    expect(
      (redis as unknown as { zscore: ReturnType<typeof vi.fn> }).zscore,
    ).not.toHaveBeenCalled();
  });

  it('reports zero honestly when nobody holds a session', async () => {
    const store = createPresenceStore(fakeRedis([]));
    expect(await store.onlineCount()).toBe(0);
  });
});
