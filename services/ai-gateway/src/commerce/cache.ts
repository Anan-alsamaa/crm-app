import type { Redis } from 'ioredis';
import { isYijiUnavailable, YijiUnavailableError } from '@yiji/shared-types';

/** How a cached "we could not ask" is written - no real answer has this key. */
const FAILED = '__commerceFailed__';

/** Options for one `wrap` (all optional; without them it behaves exactly as before). */
export interface CommerceWrapOptions<T> {
  /**
   * A "no" answer is cached for this long instead of `ttlSeconds`. A no can
   * become a yes (a customer installs the app), so it is held for less time.
   */
  negativeTtlSeconds?: number;
  /** Which answers are a "no". */
  isNegative?: (value: T) => boolean;
  /**
   * Remember a "could not ask" (`isYijiUnavailable`) for this long, and answer
   * repeats of the question with the same failure WITHOUT calling upstream
   * (incident 2026-10-26: a failing Yiji was asked again on every refocus).
   */
  failTtlSeconds?: number;
  /**
   * Single-flight ACROSS gateway tasks: hold a Redis lock while asking, and
   * have other tasks wait up to this long for the answer instead of asking
   * too. In-process coalescing alone is still one call per task.
   */
  lockMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
 * exactly today's behaviour. An upstream failure is NOT cached by default —
 * caching a transient error would turn one bad second into a bad minute. The
 * routes whose repeats once flooded Yiji opt in to a SHORT failure memory
 * (`failTtlSeconds`), because there a bad minute is the lesser harm.
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

  /** A cached entry as the caller sees it: the value, or the failure re-thrown. */
  private static decode<T>(raw: string): T {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && FAILED in parsed) {
      const why = String((parsed as Record<string, unknown>)[FAILED]);
      throw new YijiUnavailableError(
        `commerce upstream failed moments ago (${why}); not asked again yet`,
      );
    }
    return parsed as T;
  }

  /** The lock's token when taken; null when another task holds it; '' when Redis could not say. */
  private async lock(key: string, ms: number): Promise<string | null> {
    const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      const ok = await this.redis.set(`${key}:lock`, token, 'PX', ms, 'NX');
      return ok === 'OK' ? token : null;
    } catch {
      return '';
    }
  }

  private async unlock(key: string, token: string): Promise<void> {
    if (!token) return;
    try {
      await this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        `${key}:lock`,
        token,
      );
    } catch {
      /* it expires on its own */
    }
  }

  /** Wait for another task's answer to land in the cache; null when it did not in time. */
  private async waitFor(key: string, ms: number): Promise<string | null> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await sleep(Math.min(150, Math.max(10, until - Date.now())));
      try {
        const raw = await this.redis.get(key);
        if (raw !== null) return raw;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Resolve `parts` from cache, or call `fetcher` once and cache the result for
   * `ttlSeconds`.
   *
   * `null` IS cached: "this customer has no orders" is an answer, and re-asking
   * it on every keystroke is the expensive mistake. A thrown error is not -
   * unless `opts.failTtlSeconds` says otherwise.
   */
  async wrap<T>(
    parts: readonly string[],
    ttlSeconds: number,
    fetcher: () => Promise<T>,
    opts: CommerceWrapOptions<T> = {},
  ): Promise<T> {
    const key = this.key(parts);

    let raw: string | null = null;
    try {
      raw = await this.redis.get(key);
    } catch {
      // Cache unavailable — fall through to the upstream call.
    }
    if (raw !== null) return CommerceCache.decode<T>(raw);

    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;

    const p = (async () => {
      let token = '';
      if (opts.lockMs) {
        const got = await this.lock(key, opts.lockMs);
        if (got === null) {
          /* Another task is asking right now: take its answer. */
          const landed = await this.waitFor(key, opts.lockMs);
          if (landed !== null) return CommerceCache.decode<T>(landed);
          const again = await this.lock(key, opts.lockMs);
          if (again === null) {
            throw new YijiUnavailableError('commerce: another task is still asking upstream');
          }
          token = again;
        } else {
          token = got;
        }
      }
      try {
        let value: T;
        try {
          value = await fetcher();
        } catch (err) {
          if (opts.failTtlSeconds && isYijiUnavailable(err)) {
            const why = err instanceof Error ? err.message.slice(0, 120) : 'unavailable';
            try {
              await this.redis.set(
                key,
                JSON.stringify({ [FAILED]: why }),
                'EX',
                opts.failTtlSeconds,
              );
            } catch {
              /* the failure still reaches this caller */
            }
          }
          throw err;
        }
        const ttl =
          opts.negativeTtlSeconds && opts.isNegative?.(value)
            ? opts.negativeTtlSeconds
            : ttlSeconds;
        try {
          await this.redis.set(key, JSON.stringify(value ?? null), 'EX', ttl);
        } catch {
          // A value we could not cache is still a value we can return.
        }
        return value;
      } finally {
        await this.unlock(key, token);
      }
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
  /**
   * The late-orders queue, polled by every agent watching it every 30s.
   *
   * SIXTY SECONDS (owner, 2026-10-12: "this is putting too much load on
   * yiji"). Twenty fetched a whole business day from Yiji three times a
   * minute, all day, to catch orders that only count as late after 60
   * minutes - a minute's staleness changes nothing an agent does. One
   * upstream call a minute however many screens are open.
   */
  lateOrders: 60,
  /*
   * DOES THIS PHONE HAVE A YIJI ACCOUNT (incident 2026-10-26). A yes does not
   * become a no: 12 hours. A no becomes a yes when the customer installs the
   * app (the agent may have just told them to): 15 minutes. A failed lookup
   * is remembered for 60 s, so a struggling Yiji is not asked again by every
   * card and every refocus.
   */
  customerExists: 12 * 60 * 60,
  customerMissing: 15 * 60,
  customerFailed: 60,
  /*
   * A FAILED late-orders / timeline fetch, remembered for 30 s: the screens
   * poll every 30 s, so while Yiji is failing each poll is answered
   * "unavailable" from here instead of each asking Yiji again.
   */
  upstreamFailed: 30,
} as const;

/**
 * How long another gateway task waits for the task already asking Yiji. The
 * client's own timeout is 6 s, so the answer (or its failure) lands within it.
 */
export const COMMERCE_SINGLE_FLIGHT_MS = 7_000;
