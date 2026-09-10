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
    }) as never;

  it('counts every agent in the shared set, not just this process', async () => {
    const store = createPresenceStore(fakeRedis(['a', 'b', 'c']));
    expect(await store.onlineCount()).toBe(3);
  });

  it('does NOT sweep by activity when counting', async () => {
    /*
     * The trap this exists to prevent. The score is last-activity, refreshed
     * only when an agent SENDS a message — so sweeping here would count an
     * agent who is signed in and reading, but has not typed for 90 seconds, as
     * offline. Membership is the question being asked; recency is a different
     * one, and conflating them is what tells a customer nobody is there.
     */
    const redis = fakeRedis(['quiet-but-present']);
    const store = createPresenceStore(redis);
    await store.onlineCount();
    expect(
      (redis as unknown as { zremrangebyscore: ReturnType<typeof vi.fn> }).zremrangebyscore,
    ).not.toHaveBeenCalled();
  });

  it('reports zero honestly when nobody holds a session', async () => {
    const store = createPresenceStore(fakeRedis([]));
    expect(await store.onlineCount()).toBe(0);
  });
});
