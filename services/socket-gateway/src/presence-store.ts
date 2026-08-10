/**
 * Online-agent registry, shared across gateway instances via Redis.
 *
 * `agent-presence.ts` tracks presence PER PROCESS, which is all the gateway needs
 * to broadcast an online count. Auto-assignment needs more: the workers service
 * decides who gets a conversation, and it is a different process — often on a
 * different host — so it cannot read another service's memory.
 *
 * Presence is therefore mirrored into a Redis sorted set, scored by last-seen
 * timestamp. That shape gives two things at once:
 *   - membership: who is online;
 *   - ordering: who has been idle longest, which is exactly the pick we want.
 *
 * Entries carry a TTL sweep rather than relying on clean disconnects. A gateway
 * that is killed never runs its cleanup, and a permanently "online" agent who is
 * actually gone would silently swallow every conversation routed to them.
 */
import type { Redis, Cluster } from 'ioredis';

/** Sorted set: member = agent user id, score = last activity (epoch ms). */
const KEY = 'presence:agents';

/**
 * Treat an agent as gone if their heartbeat is older than this. Comfortably
 * longer than the refresh interval so a slow tick does not evict a live agent.
 */
export const PRESENCE_TTL_MS = 90_000;

export interface PresenceStore {
  online(userId: string): Promise<void>;
  offline(userId: string): Promise<void>;
  /** Idlest first — the natural assignment order. Excludes stale entries. */
  idleFirst(): Promise<string[]>;
  /** Mark activity, pushing the agent to the BACK of the idle queue. */
  touch(userId: string): Promise<void>;
}

export function createPresenceStore(redis: Redis | Cluster): PresenceStore {
  const now = (): number => Date.now();

  async function sweep(): Promise<void> {
    // Drop anything older than the TTL. Cheap, and it means a hard-killed
    // gateway self-heals instead of leaving ghost agents in the rotation.
    await redis.zremrangebyscore(KEY, '-inf', now() - PRESENCE_TTL_MS);
  }

  return {
    async online(userId) {
      await redis.zadd(KEY, now(), userId);
    },
    async offline(userId) {
      await redis.zrem(KEY, userId);
    },
    async touch(userId) {
      // Only refresh someone already present: a `touch` from an agent who has
      // signed out must not resurrect them.
      const score = await redis.zscore(KEY, userId);
      if (score !== null) await redis.zadd(KEY, now(), userId);
    },
    async idleFirst() {
      await sweep();
      // Ascending score = oldest activity first = idlest first.
      return redis.zrange(KEY, 0, -1);
    },
  };
}
