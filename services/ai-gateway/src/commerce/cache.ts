import type { Redis } from 'ioredis';

/**
 * Read-through cache for the Yiji commerce proxy.
 *
 * Every commerce call is a round trip to an external API we do not control; a
 * measured `/commerce/orders` costs ~200ms and an order detail ~300ms, and the
 * inbox needs both before it can show anything. Neither answer changes on the
 * timescale an agent reads them over, so caching is the whole difference
 * between "the panel appears" and "the panel arrives".
 *
 * Two mechanisms, and both matter:
 *
 *  - **Redis**, so the second agent to open the same chat pays nothing, and so
 *    the cost is not re-paid every time the panel remounts.
 *  - **In-flight coalescing**, so ten simultaneous opens of the same customer
 *    make ONE upstream call. Without it a cache is useless against exactly the
 *    burst it exists for — a cold key with ten concurrent readers is ten
 *    upstream calls, all of which then write the same value.
 *
 * Failure is never fatal: a Redis outage degrades to calling upstream, which is
 * exactly today's behaviour. An upstream failure is NOT cached — caching a
 * transient error would turn one bad second into a bad minute.
 */
export class CommerceCache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'commerce',
  ) {}

  private key(parts: readonly string[]): string {
    return `${this.prefix}:${parts.join(':')}`;
  }

  /**
   * Resolve `parts` from cache, or call `fetcher` once and cache the result for
   * `ttlSeconds`.
   *
   * `null` IS cached: "this customer has no orders" is an answer, and re-asking
   * it on every keystroke is the expensive mistake. A thrown error is not.
   */
  async wrap<T>(
    parts: readonly string[],
    ttlSeconds: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const key = this.key(parts);

    try {
      const raw = await this.redis.get(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      // Cache unavailable — fall through to the upstream call.
    }

    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;

    const p = (async () => {
      const value = await fetcher();
      try {
        await this.redis.set(key, JSON.stringify(value ?? null), 'EX', ttlSeconds);
      } catch {
        // A value we could not cache is still a value we can return.
      }
      return value;
    })().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, p);
    return p;
  }
}

/**
 * How long each kind of commerce answer stays useful.
 *
 * An order's contents are effectively immutable once placed, so its detail can
 * be held far longer than the LIST it appears in — the list changes the moment
 * the customer orders again, and an agent who has just been told "I ordered two
 * minutes ago" must be able to see it.
 */
export const COMMERCE_TTL = {
  orders: 45,
  order: 300,
  activity: 60,
} as const;
