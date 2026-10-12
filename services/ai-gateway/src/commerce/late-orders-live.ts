import type { Redis } from 'ioredis';
import { envKey } from '@yiji/shared-config/redis';
import {
  LATE_ORDERS_DEMAND_KEY,
  lateOrdersSnapshotKey,
  type LateOrdersDemand,
  type LateOrdersSnapshot,
} from '@yiji/shared-types';

/**
 * The gateway's side of the live late-orders snapshot (owner, 2026-10-12).
 *
 * Two small jobs, both on Redis and both NEVER fatal:
 *  - `registerDemand`: "a screen is watching this vendor, with this threshold"
 *    - what makes the workers' poller ask Yiji for it at all;
 *  - `readSnapshot`: the poller's latest answer, which the route serves when it
 *    is fresh.
 *
 * A Redis error on either is swallowed: the route then asks Yiji exactly as it
 * did before the snapshot existed, so the worst case of this layer failing is
 * today's behaviour, never an empty queue.
 */
export interface LateOrdersLiveStore {
  registerDemand(vendorKey: string, thresholdMinutes: number): Promise<void>;
  readSnapshot(vendorKey: string): Promise<LateOrdersSnapshot | null>;
}

export class RedisLateOrdersLiveStore implements LateOrdersLiveStore {
  constructor(
    private readonly redis: Pick<Redis, 'get' | 'hset'>,
    private readonly now: () => number = Date.now,
  ) {}

  async registerDemand(vendorKey: string, thresholdMinutes: number): Promise<void> {
    const demand: LateOrdersDemand = { thresholdMinutes, at: this.now() };
    try {
      await this.redis.hset(envKey(LATE_ORDERS_DEMAND_KEY), vendorKey, JSON.stringify(demand));
    } catch {
      /* No demand recorded = the poller skips this vendor and the route keeps
         asking Yiji through its own cache. Never a failed request. */
    }
  }

  async readSnapshot(vendorKey: string): Promise<LateOrdersSnapshot | null> {
    try {
      const raw = await this.redis.get(envKey(lateOrdersSnapshotKey(vendorKey)));
      return raw ? (JSON.parse(raw) as LateOrdersSnapshot) : null;
    } catch {
      return null;
    }
  }
}
