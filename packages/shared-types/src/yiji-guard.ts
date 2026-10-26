import { YijiUnavailableError } from './yiji-impl.js';
import {
  setYijiOutboundGuard,
  type YijiGuardOutcome,
  type YijiOutboundGuard,
} from './yiji-guard-registry.js';
import { reportYijiUsage, type YijiUsageService, type YijiUsageSink } from './yiji-usage.js';

/**
 * NO CLIENT, BUG OR USER MAY FLOOD YIJI AGAIN (incident 2026-10-26).
 *
 * One admin page asked `/commerce/customer-exists` once per card - 378 cards,
 * re-asked on every refocus - and ~3,800 lookups in 25 minutes reached Yiji's
 * admin API. Yiji throttled our AWS egress (429, then 6 s timeouts on EVERY
 * call), and the late-orders TV, which has nothing to do with coupons, went
 * stale. The day ended at 13,311 calls against 3,442 the day before.
 *
 * The page is fixed; this makes the next such page harmless. Every outbound
 * call from every service passes `admit()` first (see yiji-guard-registry):
 *
 *  1. A GLOBAL BUDGET, in Redis, shared by every task of every service - Yiji
 *     sees one egress, so one budget. Fixed one-second and one-minute windows.
 *  2. PRIORITIES. `critical` work (the late-orders poll, coupon push/remove,
 *     push notifications, logins) is NEVER refused: it is counted, smoothed
 *     over a busy second, and always sent. `normal` (agents' order panels)
 *     may use at most `normalPerMinute` and waits up to three seconds for room.
 *     `low` (the UI's phone lookups) may use at most `lowPerMinute` and is
 *     refused AT ONCE when there is none - a refusal the portals already show
 *     as "could not check", instead of a queue that grows behind a flood.
 *  3. A CIRCUIT BREAKER. A 429 (Retry-After honoured) or a burst of timeouts
 *     opens it for every task at once: non-critical calls stop for the
 *     cool-down, critical ones keep their own pace. Opening and closing are
 *     each reported ONCE, never per call.
 *
 * Refusals are `YijiShedError`, a `YijiUnavailableError`: every caller already
 * treats that as "we could not ask" (a 504 from the gateway, a BullMQ retry in
 * the workers), never as an answer.
 *
 * Redis trouble never stops Yiji work: each store call has a short deadline,
 * and a failing Redis falls back to a per-process budget with the same limits.
 */

export type YijiPriority = 'critical' | 'normal' | 'low';

/** The operation a breaker transition is recorded under in `yiji_api_usage`. */
export const YIJI_GUARD_BREAKER_OPERATION = 'guard.breaker';

/** Guard bookkeeping rows are not calls to Yiji; totals leave them out. */
export function isYijiGuardOperation(operation: string | null | undefined): boolean {
  return String(operation ?? '').startsWith('guard.');
}

/**
 * Which class a call is, by the service making it and what it asks.
 *
 * The workers' jobs are the critical path (the poll the TV reads, coupons a
 * supervisor approved, pushes a customer is waiting for) and are few by
 * construction - EXCEPT their phone lookups, which the signup watch repeats
 * for every held coupon; those are `normal`, and a refusal is a BullMQ retry.
 * The socket-gateway's user lookup identifies a customer opening a chat. In
 * the ai-gateway everything is browser-driven: the coupon card's phone lookup
 * is `low` (it is what flooded), the rest `normal`. A login is always
 * critical - refusing one would refuse the call it was made for.
 */
export function yijiPriorityFor(service: YijiUsageService, operation: string): YijiPriority {
  if (operation === 'login') return 'critical';
  if (service === 'workers') return operation === 'customer.lookup' ? 'normal' : 'critical';
  if (service === 'socket-gateway') return operation === 'user.lookup' ? 'critical' : 'normal';
  return operation === 'customer.lookup' ? 'low' : 'normal';
}

export interface YijiGuardLimits {
  /** Calls a second, every class together. Critical waits for room, then goes. */
  perSecond: number;
  /** Calls a minute, every class together; normal/low are refused past it. */
  perMinute: number;
  /** Of `perMinute`, what normal + low together may use. The rest is critical's. */
  normalPerMinute: number;
  /** Of `normalPerMinute`, what low may use. */
  lowPerMinute: number;
  /** Low calls a second. */
  lowPerSecond: number;
  /** Longest a normal call waits for room before it is refused. */
  normalWaitMs: number;
  /** Longest a critical call waits for a free second before it goes anyway. */
  criticalWaitMs: number;
  /** Timeouts / 5xx within `breakerWindowSec` that open the breaker. */
  breakerFailures: number;
  breakerWindowSec: number;
  /** Cool-down when Yiji gave no Retry-After. */
  breakerCooldownSec: number;
  /** Ceiling on any cool-down, Retry-After included. */
  breakerMaxCooldownSec: number;
}

/**
 * THE NUMBERS, and why.
 *
 * A normal day is ~3,400 calls (2026-10-25): ~2.4 a minute on average, a few
 * dozen a minute at the busiest - the poll (1/min), agents' order panels, the
 * TV's service-time timelines (cached 5 min each). What tripped Yiji was
 * ~150 a minute sustained (3,800 in 25 min). So:
 *
 *  - 100/min overall: well under the rate that tripped Yiji, several times a
 *    busy minute's real need.
 *  - 70/min for normal + low, so 30/min is always left for critical work.
 *  - 30/min (and 2/s) for low: a person checking cards one at a time never
 *    meets it; a page fanning out over hundreds of cards meets it in seconds.
 *  - 20/s: the per-MINUTE ceiling is what protects Yiji (the flood was a
 *    steady ~2.5/s); the per-second one only spreads bursts. The TV asks for
 *    up to 50 service-time timelines at once, and has done daily without
 *    trouble - at 20/s with a 3 s wait for room they all still go.
 *  - The breaker: any 429, or 8 timeouts/5xx in 30 s (a healthy Yiji answers
 *    in ~300 ms; eight timeouts is an outage or a throttle, not bad luck).
 *    60 s cool-down unless Yiji says otherwise, never more than 10 minutes.
 *
 * All env-tunable (`yijiGuardLimitsFromEnv`), so a busier future or a limit
 * Yiji publishes is a task-definition change, not a release.
 */
export const DEFAULT_YIJI_GUARD_LIMITS: Readonly<YijiGuardLimits> = Object.freeze({
  perSecond: 20,
  perMinute: 100,
  normalPerMinute: 70,
  lowPerMinute: 30,
  lowPerSecond: 2,
  normalWaitMs: 3_000,
  criticalWaitMs: 3_000,
  breakerFailures: 8,
  breakerWindowSec: 30,
  breakerCooldownSec: 60,
  breakerMaxCooldownSec: 600,
});

/** Shortest cool-down: a `Retry-After: 0` must not turn the breaker into a no-op. */
const MIN_COOLDOWN_MS = 10_000;

/** Fill in, then make consistent: low <= normal <= overall. */
export function resolveYijiGuardLimits(partial: Partial<YijiGuardLimits> = {}): YijiGuardLimits {
  const l = { ...DEFAULT_YIJI_GUARD_LIMITS, ...partial };
  l.normalPerMinute = Math.min(l.normalPerMinute, l.perMinute);
  l.lowPerMinute = Math.min(l.lowPerMinute, l.normalPerMinute);
  l.lowPerSecond = Math.min(l.lowPerSecond, l.perSecond);
  return l;
}

const ENV_LIMITS: Array<[keyof YijiGuardLimits, string]> = [
  ['perSecond', 'YIJI_BUDGET_PER_SEC'],
  ['perMinute', 'YIJI_BUDGET_PER_MIN'],
  ['normalPerMinute', 'YIJI_BUDGET_NORMAL_PER_MIN'],
  ['lowPerMinute', 'YIJI_BUDGET_LOW_PER_MIN'],
  ['lowPerSecond', 'YIJI_BUDGET_LOW_PER_SEC'],
  ['normalWaitMs', 'YIJI_BUDGET_NORMAL_WAIT_MS'],
  ['criticalWaitMs', 'YIJI_BUDGET_CRITICAL_WAIT_MS'],
  ['breakerFailures', 'YIJI_BREAKER_FAILURES'],
  ['breakerWindowSec', 'YIJI_BREAKER_WINDOW_SEC'],
  ['breakerCooldownSec', 'YIJI_BREAKER_COOLDOWN_SEC'],
  ['breakerMaxCooldownSec', 'YIJI_BREAKER_MAX_COOLDOWN_SEC'],
];

/**
 * The limits from a service's env. A missing, non-numeric or non-positive
 * value keeps the default - a typo must never become "no limit" or "zero".
 */
export function yijiGuardLimitsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): YijiGuardLimits {
  const partial: Partial<YijiGuardLimits> = {};
  for (const [field, name] of ENV_LIMITS) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) partial[field] = v;
  }
  return resolveYijiGuardLimits(partial);
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. Null when absent/unreadable. */
export function retryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  const raw = header?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** A call the guard would not send. Still "we could not ask" to every caller. */
export class YijiShedError extends YijiUnavailableError {
  readonly isYijiShed = true;
  constructor(
    readonly operation: string,
    readonly priority: YijiPriority,
    readonly reason: 'breaker' | 'budget',
    readonly retryAfterMs: number,
  ) {
    super(
      reason === 'breaker'
        ? `yiji call not sent (${operation}): Yiji is cooling down after rate limiting / failures`
        : `yiji call not sent (${operation}): the ${priority}-priority Yiji budget is used up`,
    );
    this.name = 'YijiShedError';
  }
}

/** By shape, like `isYijiUnavailable`. */
export function isYijiShed(err: unknown): err is YijiShedError {
  return typeof err === 'object' && err !== null && 'isYijiShed' in err;
}

/* ── Stores ───────────────────────────────────────────────────────── */

export type YijiTakeResult =
  | { ok: true }
  | { ok: false; reason: 'breaker' | 'second' | 'minute'; retryInMs: number };

/** Where the counters and the breaker live. Redis in a service; memory in tests / as fallback. */
export interface YijiGuardStore {
  /** Count one call of `cls` if it fits (or unconditionally with `force`). */
  take(
    cls: YijiPriority,
    nowMs: number,
    limits: YijiGuardLimits,
    force: boolean,
  ): Promise<YijiTakeResult>;
  /** Open, or extend, the breaker for `ms`. True only for the call that OPENED it. */
  open(nowMs: number, ms: number, reason: string): Promise<boolean>;
  /** Count one failed call; the failures in the current window. */
  fail(nowMs: number, windowSec: number): Promise<number>;
  /** 'open' while open; 'closed-now' exactly once after an open breaker expired; else 'closed'. */
  settle(nowMs: number): Promise<'open' | 'closed-now' | 'closed'>;
}

const retryIn = (reason: 'second' | 'minute', nowMs: number): number =>
  reason === 'second' ? 1_000 - (nowMs % 1_000) : 60_000 - (nowMs % 60_000);

/**
 * The same rules as the Redis store, in one process. The fallback when Redis
 * cannot answer, and what the tests drive.
 */
export class MemoryYijiGuardStore implements YijiGuardStore {
  private readonly counters = new Map<string, { n: number; exp: number }>();
  private breakerUntil = 0;
  private wasOpen = false;

  private get(key: string, nowMs: number): number {
    const c = this.counters.get(key);
    if (!c || c.exp <= nowMs) return 0;
    return c.n;
  }

  private bump(key: string, nowMs: number, ttlMs: number): number {
    const c = this.counters.get(key);
    const n = c && c.exp > nowMs ? c.n + 1 : 1;
    this.counters.set(key, { n, exp: c && c.exp > nowMs ? c.exp : nowMs + ttlMs });
    if (this.counters.size > 1_000) {
      for (const [k, v] of this.counters) if (v.exp <= nowMs) this.counters.delete(k);
    }
    return n;
  }

  async take(
    cls: YijiPriority,
    nowMs: number,
    limits: YijiGuardLimits,
    force: boolean,
  ): Promise<YijiTakeResult> {
    if (cls !== 'critical' && this.breakerUntil > nowMs) {
      return { ok: false, reason: 'breaker', retryInMs: this.breakerUntil - nowMs };
    }
    const sec = Math.floor(nowMs / 1_000);
    const min = Math.floor(nowMs / 60_000);
    const k = { s: `s:${sec}`, sl: `sl:${sec}`, m: `m:${min}`, mn: `mn:${min}`, ml: `ml:${min}` };
    if (!force) {
      const deny = (reason: 'second' | 'minute'): YijiTakeResult => ({
        ok: false,
        reason,
        retryInMs: retryIn(reason, nowMs),
      });
      if (this.get(k.s, nowMs) >= limits.perSecond) return deny('second');
      if (cls !== 'critical') {
        if (this.get(k.m, nowMs) >= limits.perMinute) return deny('minute');
        if (this.get(k.mn, nowMs) >= limits.normalPerMinute) return deny('minute');
        if (cls === 'low') {
          if (this.get(k.ml, nowMs) >= limits.lowPerMinute) return deny('minute');
          if (this.get(k.sl, nowMs) >= limits.lowPerSecond) return deny('second');
        }
      }
    }
    this.bump(k.s, nowMs, 1_000);
    this.bump(k.m, nowMs, 60_000);
    if (cls !== 'critical') this.bump(k.mn, nowMs, 60_000);
    if (cls === 'low') {
      this.bump(k.ml, nowMs, 60_000);
      this.bump(k.sl, nowMs, 1_000);
    }
    return { ok: true };
  }

  async open(nowMs: number, ms: number): Promise<boolean> {
    const wasOpenNow = this.breakerUntil > nowMs;
    if (nowMs + ms > this.breakerUntil) this.breakerUntil = nowMs + ms;
    this.wasOpen = true;
    return !wasOpenNow;
  }

  async fail(nowMs: number, windowSec: number): Promise<number> {
    return this.bump(`f:${Math.floor(nowMs / (windowSec * 1_000))}`, nowMs, windowSec * 1_000);
  }

  async settle(nowMs: number): Promise<'open' | 'closed-now' | 'closed'> {
    if (this.breakerUntil > nowMs) return 'open';
    if (!this.wasOpen) return 'closed';
    this.wasOpen = false;
    return 'closed-now';
  }
}

/** The Redis surface the store needs; ioredis' `Redis` and `Cluster` both have it. */
export interface YijiGuardRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/*
 * The Lua scripts. Every key carries ONE hash tag, so on a cluster-mode
 * ElastiCache they share a slot and a multi-key script is legal (CROSSSLOT
 * otherwise - see shared-config/redis bullPrefix).
 *
 * TAKE: KEYS = breaker, s, sl, m, mn, ml; ARGV = cls, perSec, perMin,
 * normalMax, lowMax, lowPerSec, force.
 */
const TAKE_LUA = `
local cls = ARGV[1]
if cls ~= 'critical' then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl > 0 then return {0, 'breaker', ttl} end
end
if ARGV[7] ~= '1' then
  local s = tonumber(redis.call('GET', KEYS[2]) or '0')
  if s >= tonumber(ARGV[2]) then return {0, 'second', 0} end
  if cls ~= 'critical' then
    local m = tonumber(redis.call('GET', KEYS[4]) or '0')
    if m >= tonumber(ARGV[3]) then return {0, 'minute', 0} end
    local mn = tonumber(redis.call('GET', KEYS[5]) or '0')
    if mn >= tonumber(ARGV[4]) then return {0, 'minute', 0} end
    if cls == 'low' then
      local ml = tonumber(redis.call('GET', KEYS[6]) or '0')
      if ml >= tonumber(ARGV[5]) then return {0, 'minute', 0} end
      local sl = tonumber(redis.call('GET', KEYS[3]) or '0')
      if sl >= tonumber(ARGV[6]) then return {0, 'second', 0} end
    end
  end
end
redis.call('INCR', KEYS[2]) redis.call('EXPIRE', KEYS[2], 2)
redis.call('INCR', KEYS[4]) redis.call('EXPIRE', KEYS[4], 70)
if cls ~= 'critical' then redis.call('INCR', KEYS[5]) redis.call('EXPIRE', KEYS[5], 70) end
if cls == 'low' then
  redis.call('INCR', KEYS[6]) redis.call('EXPIRE', KEYS[6], 70)
  redis.call('INCR', KEYS[3]) redis.call('EXPIRE', KEYS[3], 2)
end
return {1, 'ok', 0}
`;

/* OPEN: KEYS = breaker, wasOpen; ARGV = ms, reason. Extends, never shortens. */
const OPEN_LUA = `
local ttl = redis.call('PTTL', KEYS[1])
local ms = tonumber(ARGV[1])
if ttl >= ms then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ms)
redis.call('SET', KEYS[2], ARGV[2], 'EX', 86400)
if ttl > 0 then return 0 end
return 1
`;

/* FAIL: KEYS = the window's counter; ARGV = window seconds. */
const FAIL_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]) + 1) end
return n
`;

/* SETTLE: KEYS = breaker, wasOpen. 2 = open, 1 = closed by this call, 0 = closed. */
const SETTLE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 2 end
return redis.call('DEL', KEYS[2])
`;

/**
 * The shared store. `scope` names the budget: every service and task that
 * passes the same scope shares one budget and one breaker.
 */
export class RedisYijiGuardStore implements YijiGuardStore {
  private readonly tag: string;

  constructor(
    private readonly redis: YijiGuardRedis,
    scope: string,
  ) {
    this.tag = `{yiji-guard:${scope}}`;
  }

  private k(...parts: Array<string | number>): string {
    return [this.tag, ...parts].join(':');
  }

  async take(
    cls: YijiPriority,
    nowMs: number,
    limits: YijiGuardLimits,
    force: boolean,
  ): Promise<YijiTakeResult> {
    const sec = Math.floor(nowMs / 1_000);
    const min = Math.floor(nowMs / 60_000);
    const res = (await this.redis.eval(
      TAKE_LUA,
      6,
      this.k('breaker'),
      this.k('s', sec),
      this.k('sl', sec),
      this.k('m', min),
      this.k('mn', min),
      this.k('ml', min),
      cls,
      limits.perSecond,
      limits.perMinute,
      limits.normalPerMinute,
      limits.lowPerMinute,
      limits.lowPerSecond,
      force ? '1' : '0',
    )) as [number | string, string, number | string];
    if (Number(res[0]) === 1) return { ok: true };
    const reason = res[1] === 'breaker' ? 'breaker' : res[1] === 'second' ? 'second' : 'minute';
    return {
      ok: false,
      reason,
      retryInMs: reason === 'breaker' ? Number(res[2]) || 1_000 : retryIn(reason, nowMs),
    };
  }

  async open(_nowMs: number, ms: number, reason: string): Promise<boolean> {
    const r = await this.redis.eval(
      OPEN_LUA,
      2,
      this.k('breaker'),
      this.k('was-open'),
      Math.max(1, Math.round(ms)),
      reason.slice(0, 200),
    );
    return Number(r) === 1;
  }

  async fail(nowMs: number, windowSec: number): Promise<number> {
    const bucket = Math.floor(nowMs / (windowSec * 1_000));
    return Number(await this.redis.eval(FAIL_LUA, 1, this.k('fail', bucket), windowSec));
  }

  async settle(): Promise<'open' | 'closed-now' | 'closed'> {
    const r = Number(await this.redis.eval(SETTLE_LUA, 2, this.k('breaker'), this.k('was-open')));
    return r === 2 ? 'open' : r === 1 ? 'closed-now' : 'closed';
  }
}

/* ── The guard ────────────────────────────────────────────────────── */

export type YijiGuardEvent =
  | { type: 'breaker_open'; reason: string; cooldownMs: number; httpStatus: number | null }
  | { type: 'breaker_closed' }
  /** At most once a minute while calls are being refused: how many, by class and why. */
  | { type: 'shedding'; counts: Record<string, number> }
  /** The shared store failed; this process is on its own budget until it answers. */
  | { type: 'store_fallback'; error: string };

export interface YijiGuardOptions {
  service: YijiUsageService;
  /** The shared store; absent = this process's own memory. */
  store?: YijiGuardStore;
  limits?: Partial<YijiGuardLimits>;
  /** Defaults to `yijiPriorityFor(service, operation)`. */
  classify?: (operation: string) => YijiPriority;
  /** State changes, once each. Must not throw (guarded anyway). */
  onEvent?: (event: YijiGuardEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Deadline on each store call before falling back to memory. Default 250 ms. */
  storeTimeoutMs?: number;
}

const SUMMARY_EVERY_MS = 60_000;

/** What `createYijiOutboundGuard` returns: the guard, plus its resolved limits. */
export interface YijiGuardHandle extends YijiOutboundGuard {
  readonly limits: YijiGuardLimits;
}

export function createYijiOutboundGuard(opts: YijiGuardOptions): YijiGuardHandle {
  const limits = resolveYijiGuardLimits(opts.limits);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const classify = opts.classify ?? ((op: string) => yijiPriorityFor(opts.service, op));
  const storeTimeoutMs = opts.storeTimeoutMs ?? 250;
  const local = new MemoryYijiGuardStore();
  const shared = opts.store ?? null;

  let sawBreaker = false;
  let lastFallbackAt = -Infinity;
  let lastSummaryAt = -Infinity;
  let shedCounts: Record<string, number> = {};

  const emit = (event: YijiGuardEvent) => {
    try {
      opts.onEvent?.(event);
    } catch {
      /* reporting never breaks a call */
    }
  };

  /** One store call: the shared store within its deadline, else this process's memory. */
  async function use<T>(fn: (s: YijiGuardStore) => Promise<T>): Promise<T> {
    if (!shared) return fn(local);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(shared),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('guard store timed out')), storeTimeoutMs);
        }),
      ]);
    } catch (err) {
      const t = now();
      if (t - lastFallbackAt >= SUMMARY_EVERY_MS) {
        lastFallbackAt = t;
        emit({ type: 'store_fallback', error: err instanceof Error ? err.message : String(err) });
      }
      return fn(local);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function shed(
    operation: string,
    cls: YijiPriority,
    reason: 'breaker' | 'budget',
    retryMs: number,
  ): never {
    const key = `${cls}:${reason}`;
    shedCounts[key] = (shedCounts[key] ?? 0) + 1;
    const t = now();
    if (t - lastSummaryAt >= SUMMARY_EVERY_MS) {
      lastSummaryAt = t;
      emit({ type: 'shedding', counts: shedCounts });
      shedCounts = {};
    }
    throw new YijiShedError(operation, cls, reason, Math.max(0, Math.round(retryMs)));
  }

  async function openBreaker(ms: number, reason: string, httpStatus: number | null) {
    sawBreaker = true;
    const cooldownMs = Math.min(
      Math.max(ms, MIN_COOLDOWN_MS),
      limits.breakerMaxCooldownSec * 1_000,
    );
    if (await use((s) => s.open(now(), cooldownMs, reason))) {
      emit({ type: 'breaker_open', reason, cooldownMs, httpStatus });
    }
  }

  async function admit(operation: string): Promise<void> {
    const cls = classify(operation);
    const started = now();
    const maxWait =
      cls === 'critical' ? limits.criticalWaitMs : cls === 'normal' ? limits.normalWaitMs : 0;
    for (;;) {
      const t = now();
      const r = await use((s) => s.take(cls, t, limits, false));
      if (r.ok) return;
      if (r.reason === 'breaker') {
        sawBreaker = true;
        shed(operation, cls, 'breaker', r.retryInMs);
      }
      const waited = now() - started;
      if (waited + r.retryInMs > maxWait) {
        /* Critical work is never refused: past its wait it goes, counted. */
        if (cls === 'critical') {
          await use((s) => s.take(cls, now(), limits, true));
          return;
        }
        shed(operation, cls, 'budget', r.retryInMs);
      }
      /* A little jitter so a crowd waiting on the same second does not
         arrive together at the start of the next one. */
      await sleep(Math.max(10, r.retryInMs) + Math.floor(Math.random() * 40));
    }
  }

  async function settleAfterSuccess() {
    if (!sawBreaker) return;
    const state = await use((s) => s.settle(now()));
    if (state === 'open') return;
    sawBreaker = false;
    if (state === 'closed-now') emit({ type: 'breaker_closed' });
  }

  function observe(operation: string, outcome: YijiGuardOutcome): void {
    const status = outcome.status;
    const run = async () => {
      if (status === 429 || (status === 503 && outcome.retryAfter)) {
        const ms = retryAfterMs(outcome.retryAfter, now()) ?? limits.breakerCooldownSec * 1_000;
        await openBreaker(ms, `HTTP ${status} from Yiji (${operation})`, status);
        return;
      }
      if (status === null || status >= 500) {
        const n = await use((s) => s.fail(now(), limits.breakerWindowSec));
        if (n >= limits.breakerFailures) {
          await openBreaker(
            limits.breakerCooldownSec * 1_000,
            `${n} Yiji calls failed (timeout / ${status ?? 'no answer'}) within ${limits.breakerWindowSec}s`,
            status,
          );
        }
        return;
      }
      if (status < 400 || status === 404) await settleAfterSuccess();
    };
    void run().catch(() => undefined);
  }

  return { admit, observe, limits };
}

/* ── Installing one in a service ──────────────────────────────────── */

export interface InstallYijiGuardOptions {
  service: YijiUsageService;
  /** The service's Redis; null/absent = a per-process budget. */
  redis?: YijiGuardRedis | null;
  env: Readonly<Record<string, string | undefined>>;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  /** `yiji_api_usage`: a breaker opening is recorded there, once, for the Admin KPI page. */
  onUsage?: YijiUsageSink;
}

/**
 * Build this service's guard from its env and install it for every Yiji
 * client in the process. `YIJI_GUARD=off` installs none (the old behaviour,
 * for an emergency only). `YIJI_GUARD_SCOPE` names the shared budget - the
 * default `yiji` is SHARED BY STAGING AND PRODUCTION on purpose: both reach
 * Yiji's production API from the same AWS egress, which is what Yiji throttles.
 */
export function installYijiOutboundGuard(opts: InstallYijiGuardOptions): YijiGuardHandle | null {
  if ((opts.env.YIJI_GUARD ?? '').trim().toLowerCase() === 'off') {
    setYijiOutboundGuard(null);
    opts.log.warn(
      { service: opts.service },
      'yiji guard OFF (YIJI_GUARD=off) - no outbound budget',
    );
    return null;
  }
  const scope = opts.env.YIJI_GUARD_SCOPE?.trim() || 'yiji';
  const guard = createYijiOutboundGuard({
    service: opts.service,
    ...(opts.redis ? { store: new RedisYijiGuardStore(opts.redis, scope) } : {}),
    limits: yijiGuardLimitsFromEnv(opts.env),
    onEvent: (e) => {
      switch (e.type) {
        case 'breaker_open':
          opts.log.warn(
            { reason: e.reason, cooldownMs: e.cooldownMs },
            'yiji breaker OPEN - non-critical Yiji calls stopped for the cool-down',
          );
          reportYijiUsage(opts.onUsage, {
            operation: YIJI_GUARD_BREAKER_OPERATION,
            account: 'crm',
            outcome: 'error',
            httpStatus: e.httpStatus,
            durationMs: 0,
            error: `breaker open ${Math.round(e.cooldownMs / 1000)}s: ${e.reason}`,
          });
          return;
        case 'breaker_closed':
          opts.log.info({}, 'yiji breaker closed - Yiji answering again');
          return;
        case 'shedding':
          opts.log.warn({ shed: e.counts }, 'yiji guard refused calls (budget / breaker)');
          return;
        case 'store_fallback':
          opts.log.warn(
            { err: e.error },
            'yiji guard: shared budget unavailable - using this process budget',
          );
      }
    },
  });
  setYijiOutboundGuard(guard);
  opts.log.info(
    { service: opts.service, scope, limits: guard.limits, shared: Boolean(opts.redis) },
    'yiji guard installed',
  );
  return guard;
}
