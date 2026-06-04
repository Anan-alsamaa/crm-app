import type { Redis } from 'ioredis';

/**
 * Sliding-window rate limit on Redis sorted sets.
 *
 * For each key we keep a ZSET of request timestamps (score = unix ms).
 * On check: drop entries older than (now - window), count remaining, allow
 * if under limit. Adds the new timestamp atomically via a Lua script so
 * concurrent requests can't squeeze past the cap.
 */

const SCRIPT = `
local key   = KEYS[1]
local now   = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttlSec = tonumber(ARGV[4])

-- Drop expired
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetAt = oldest[2] and (tonumber(oldest[2]) + windowMs) or (now + windowMs)
  return {0, count, resetAt}
end
redis.call('ZADD', key, now, now .. '-' .. math.random(0, 1000000))
redis.call('EXPIRE', key, ttlSec)
return {1, count + 1, now + windowMs}
`;

export interface RateLimitVerdict {
  allowed: boolean;
  count: number;
  resetAt: number;
  limit: number;
}

export class SlidingWindowLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly windowMs: number,
    private readonly limit: number,
    private readonly keyPrefix = 'rl',
  ) {}

  async check(scope: string): Promise<RateLimitVerdict> {
    const key = `${this.keyPrefix}:${scope}`;
    const now = Date.now();
    const ttl = Math.ceil(this.windowMs / 1000) + 5;
    const res = (await this.redis.eval(SCRIPT, 1, key, now, this.windowMs, this.limit, ttl)) as [
      number,
      number,
      number,
    ];
    return {
      allowed: res[0] === 1,
      count: res[1],
      resetAt: res[2],
      limit: this.limit,
    };
  }
}

/**
 * Monthly usage cap — a simple counter keyed by `YYYY-MM` with a 35-day TTL
 * so it self-cleans after the month rolls. Returns whether the call is
 * allowed AND increments atomically.
 *
 * `cap = 0` means unlimited.
 */
export class MonthlyCap {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'aicap',
  ) {}

  private monthKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** Check + increment. Returns whether the request fits inside the cap. */
  async tryConsume(
    scope: string,
    cap: number,
  ): Promise<{ allowed: boolean; used: number; cap: number }> {
    if (cap <= 0) {
      // Unlimited — still track usage for reporting.
      const key = `${this.keyPrefix}:${scope}:${this.monthKey()}`;
      const used = await this.redis.incr(key);
      if (used === 1) await this.redis.expire(key, 60 * 60 * 24 * 35);
      return { allowed: true, used, cap: 0 };
    }
    const key = `${this.keyPrefix}:${scope}:${this.monthKey()}`;
    const used = await this.redis.incr(key);
    if (used === 1) await this.redis.expire(key, 60 * 60 * 24 * 35);
    if (used > cap) {
      // Roll back so we don't over-charge.
      await this.redis.decr(key);
      return { allowed: false, used: cap, cap };
    }
    return { allowed: true, used, cap };
  }

  async currentUsage(scope: string): Promise<number> {
    const key = `${this.keyPrefix}:${scope}:${this.monthKey()}`;
    const raw = await this.redis.get(key);
    return raw ? Number.parseInt(raw, 10) : 0;
  }
}
