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
  /**
   * How many agents hold a session RIGHT NOW, across every gateway instance.
   *
   * Deliberately does NOT sweep by activity. The score is last-activity,
   * refreshed only when an agent sends a message, so sweeping here would count
   * an agent who is signed in and reading — but has not typed for 90 seconds —
   * as offline, and tell every customer "our agents are offline right now".
   * Membership is the question; recency is a different one.
   */
  onlineCount(): Promise<number>;
  /**
   * Keep every currently-connected agent's entry fresh.
   *
   * Called on a timer by the gateway with the agents it actually holds sockets
   * for. This is what lets `onlineCount` sweep: without it the score means
   * "last typed" and a quiet agent would be swept out from under a customer.
   */
  heartbeatAll(userIds: string[]): Promise<void>;
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
    async onlineCount() {
      /*
       * SWEEP FIRST, THEN COUNT — and this is only safe because the gateway
       * now heartbeats every CONNECTED agent (see `heartbeatAll`).
       *
       * Counting without sweeping reported agents who were long gone: nothing
       * removes an entry when a task is hard-killed or replaced during a
       * deploy, so every rollout leaked a ghost. Measured on staging with ZERO
       * agents connected, `/debug/presence` said `distinctOnline: 0` while this
       * count said 3, and the widget duly told customers agents were available.
       * Waiting for a reply that cannot come is worse than being told to use
       * WhatsApp.
       *
       * Sweeping here was previously WRONG because the score only moved when an
       * agent sent a message, so a signed-in agent reading quietly for 90s
       * looked gone. The heartbeat fixes the meaning of the score: it now says
       * "still holding a socket", not "last typed". Recency and membership
       * finally answer the same question, so the sweep is correct both ways.
       */
      await sweep();
      return redis.zcard(KEY);
    },
    async heartbeatAll(userIds) {
      if (userIds.length === 0) return;
      /*
       * Refresh only agents ALREADY present. A heartbeat must never re-add
       * someone who signed out — that is the same resurrection `touch` guards
       * against, and here it would undo a logout on the very next tick.
       */
      const scores = await Promise.all(userIds.map((id) => redis.zscore(KEY, id)));
      const live = userIds.filter((_, i) => scores[i] !== null);
      if (live.length === 0) return;
      const at = now();
      const pipe = redis.multi();
      for (const id of live) pipe.zadd(KEY, at, id);
      await pipe.exec();
    },
    async idleFirst() {
      await sweep();
      // Ascending score = oldest activity first = idlest first.
      return redis.zrange(KEY, 0, -1);
    },
  };
}
