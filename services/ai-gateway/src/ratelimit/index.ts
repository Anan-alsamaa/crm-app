import { envKey } from '@yiji/shared-config/redis';
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
    // Namespaced: a shared cluster would otherwise let staging traffic
    // consume production's rate-limit budget.
    private readonly keyPrefix = envKey('rl'),
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
    // Namespaced: the monthly AI spend cap must count each environment
    // separately, or staging usage exhausts production's allowance.
    private readonly keyPrefix = envKey('aicap'),
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

export interface DailyQuotaVerdict {
  allowed: boolean;
  /** Units consumed today, after this attempt (clamped to `limit` on reject). */
  used: number;
  /** The configured limit (0 = unlimited). */
  limit: number;
  /** Epoch ms of the next UTC midnight — when the counter rolls. */
  resetAt: number;
}

/**
 * Per-user DAILY quota.
 *
 * A stricter, longer-horizon companion to SlidingWindowLimiter: the sliding
 * window stops bursts, this stops steady all-day grinding of a paid provider.
 *
 * One counter per scope per UTC day (`<prefix>:<scope>:<YYYY-MM-DD>`), expiring
 * at the next UTC midnight — so it self-cleans and the reset is simply the date
 * key changing. INCR is atomic, so concurrent requests cannot both slip past
 * the limit; an over-limit attempt is rolled back with DECR (same pattern as
 * MonthlyCap) so a rejected call never costs the user budget.
 *
 * `limit = 0` means unlimited (usage is still tracked, for reporting).
 */
export class DailyQuota {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'help:quota',
    /** Injectable clock — lets tests roll the date without faking timers. */
    private readonly now: () => number = Date.now,
  ) {}

  /** UTC calendar day, e.g. `2026-07-28`. */
  private dayKey(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`;
  }

  private key(scope: string, d: Date): string {
    return `${this.keyPrefix}:${scope}:${this.dayKey(d)}`;
  }

  /** Epoch ms of the next UTC midnight. */
  private nextUtcMidnight(d: Date): number {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  }

  /** Check + increment atomically. Returns whether the request fits today. */
  async tryConsume(scope: string, limit: number): Promise<DailyQuotaVerdict> {
    const nowMs = this.now();
    const d = new Date(nowMs);
    const key = this.key(scope, d);
    const resetAt = this.nextUtcMidnight(d);

    const used = await this.redis.incr(key);
    if (used === 1) {
      // TTL to end-of-day so the key disappears on its own. +60s of slack so a
      // request racing midnight can't expire the counter it just created.
      await this.redis.expire(key, Math.max(Math.ceil((resetAt - nowMs) / 1000), 1) + 60);
    }
    if (limit > 0 && used > limit) {
      await this.redis.decr(key); // roll back — a rejected call costs nothing
      return { allowed: false, used: limit, limit, resetAt };
    }
    return { allowed: true, used, limit, resetAt };
  }

  /**
   * Give one unit back — for calls that consumed quota but produced nothing
   * billable-worthy (an off-topic refusal, or a provider failure). Clamped at
   * zero so repeated refunds can't mint budget.
   */
  async refund(scope: string): Promise<void> {
    const key = this.key(scope, new Date(this.now()));
    const left = await this.redis.decr(key);
    if (left < 0) await this.redis.incr(key); // never go negative
  }

  async currentUsage(scope: string): Promise<number> {
    const raw = await this.redis.get(this.key(scope, new Date(this.now())));
    return raw ? Number.parseInt(raw, 10) : 0;
  }
}
