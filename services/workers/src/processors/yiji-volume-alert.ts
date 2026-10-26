import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { aggregate, readItems, readUsers } from '@directus/sdk';
import { envKey } from '@yiji/shared-config/redis';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  YIJI_GUARD_BREAKER_OPERATION,
  errorText,
  isYijiGuardOperation,
  type NotificationJob,
} from '@yiji/shared-types';
import { YIJI_USAGE_COLLECTION } from './yiji-usage.js';

/**
 * THE ALARM THAT WAS MISSING ON 2026-10-26.
 *
 * Yiji's traffic tripled from 01:00 that day (13,311 calls against 3,442 the
 * day before) and nobody knew until the late-orders TV froze at 16:15 - the
 * numbers were in `yiji_api_usage` all along, and nothing read them.
 *
 * Every 15 minutes this reads the last hour and tells the Administrator, in
 * the app, when:
 *   - Yiji answered 429 at all, or the outbound guard's breaker opened
 *     (either is Yiji telling us to stop), or
 *   - the last hour is more than `factor` x the hourly average of the week
 *     before AND above `minPerHour` (a quiet night doubling is not news), or
 *   - the last hour is above `maxPerHour` whatever the baseline.
 *
 * Three grouped counts on an indexed table, no rows downloaded. One alert per
 * three hours at most (a Redis key), so a long incident is one notification,
 * not twelve. The message names the busiest operations, which is the first
 * thing the reader will want ("customer.lookup: 3,412").
 */

export const YIJI_VOLUME_ALERT_JOB = 'yiji_volume_alert';
const SCHEDULER = 'yiji-volume-alert';
export const DEFAULT_YIJI_VOLUME_ALERT_MS = 15 * 60_000;
const DEDUPE_SEC = 3 * 60 * 60;
const HOUR_MS = 60 * 60_000;
/** The page the alert links to (admin portal). */
const ADMIN_KPI_LINK = '/reports/admin-kpi';
/** Who is told: the owner tier (memory: notification-recipients-trap - by role NAME). */
const ALERT_ROLES = ['Administrator'] as const;

export interface YijiVolumeThresholds {
  factor: number;
  minPerHour: number;
  maxPerHour: number;
}

/**
 * A normal day is ~3,400 calls, ~140 an hour on average with busier daytime
 * hours. 500/h is well above a busy legitimate hour; the flood ran at ~9,000/h.
 */
export const DEFAULT_YIJI_VOLUME_THRESHOLDS: Readonly<YijiVolumeThresholds> = Object.freeze({
  factor: 2,
  minPerHour: 500,
  maxPerHour: 1_500,
});

export function yijiVolumeThresholdsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): YijiVolumeThresholds {
  const num = (name: string, fallback: number) => {
    const v = Number(env[name]?.trim());
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const d = DEFAULT_YIJI_VOLUME_THRESHOLDS;
  return {
    factor: num('YIJI_ALERT_FACTOR', d.factor),
    minPerHour: num('YIJI_ALERT_MIN_PER_HOUR', d.minPerHour),
    maxPerHour: num('YIJI_ALERT_MAX_PER_HOUR', d.maxPerHour),
  };
}

export interface YijiVolumeFacts {
  /** Calls in the last hour (guard bookkeeping rows excluded). */
  lastHour: number;
  /** Average calls an hour over the week before the last hour. */
  baselinePerHour: number;
  /** Responses with HTTP 429 in the last hour. */
  rateLimited: number;
  /** Times the guard's breaker opened in the last hour. */
  breakerOpens: number;
  /** Busiest operations in the last hour, busiest first. */
  topOperations: Array<{ operation: string; count: number }>;
}

/** Pure: whether the facts deserve an alert, and why (in words for the owner). */
export function yijiVolumeVerdict(
  f: YijiVolumeFacts,
  t: YijiVolumeThresholds = DEFAULT_YIJI_VOLUME_THRESHOLDS,
): { alert: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (f.rateLimited > 0) {
    reasons.push(`Yiji refused ${f.rateLimited} call(s) with "too many requests" (429)`);
  }
  if (f.breakerOpens > 0) {
    reasons.push(`the CRM paused non-urgent Yiji calls ${f.breakerOpens} time(s)`);
  }
  if (f.lastHour > t.maxPerHour) {
    reasons.push(`${f.lastHour} Yiji calls in the last hour (limit ${t.maxPerHour})`);
  } else if (f.lastHour >= t.minPerHour && f.lastHour > t.factor * f.baselinePerHour) {
    reasons.push(
      `${f.lastHour} Yiji calls in the last hour, ${
        f.baselinePerHour > 0 ? `${(f.lastHour / f.baselinePerHour).toFixed(1)}x` : 'far above'
      } the usual ${Math.round(f.baselinePerHour)}/hour`,
    );
  }
  return { alert: reasons.length > 0, reasons };
}

type Row = Record<string, unknown> & { count?: unknown };
const toNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Three grouped counts on `yiji_api_usage`. Throws when Directus cannot answer. */
export async function readYijiVolumeFacts(
  directus: YijiDirectusClient,
  now: Date,
): Promise<YijiVolumeFacts> {
  const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * HOUR_MS).toISOString();
  const count = (filter: object, groupBy?: string[]) =>
    directus.request(
      aggregate(
        YIJI_USAGE_COLLECTION as never,
        {
          aggregate: { count: '*' },
          ...(groupBy ? { groupBy } : {}),
          query: { filter, limit: -1 },
        } as never,
      ) as never,
    ) as unknown as Promise<Row[]>;

  const [recent, before, oldest] = await Promise.all([
    count({ date_created: { _gte: hourAgo } }, ['operation', 'http_status']),
    count({
      _and: [
        { date_created: { _gte: weekAgo } },
        { date_created: { _lt: hourAgo } },
        { operation: { _nstarts_with: 'guard.' } },
      ],
    }),
    /* The week may not be full yet (a new table, a purge): average over the
       hours the rows actually span, not a week of mostly nothing. */
    directus.request(
      readItems(
        YIJI_USAGE_COLLECTION as never,
        {
          fields: ['date_created'],
          filter: { date_created: { _gte: weekAgo } },
          sort: ['date_created'],
          limit: 1,
        } as never,
      ) as never,
    ) as unknown as Promise<Array<{ date_created?: string }>>,
  ]);

  let lastHour = 0;
  let rateLimited = 0;
  let breakerOpens = 0;
  const byOp = new Map<string, number>();
  for (const r of recent ?? []) {
    const n = toNum(r.count);
    const op = String(r.operation ?? 'other');
    if (op === YIJI_GUARD_BREAKER_OPERATION) {
      breakerOpens += n;
      continue;
    }
    if (isYijiGuardOperation(op)) continue;
    lastHour += n;
    if (toNum(r.http_status) === 429) rateLimited += n;
    byOp.set(op, (byOp.get(op) ?? 0) + n);
  }

  const beforeCount = (before ?? []).reduce((s, r) => s + toNum(r.count), 0);
  const firstAt = Date.parse(oldest?.[0]?.date_created ?? '');
  const spanHours = Number.isFinite(firstAt)
    ? Math.min(7 * 24 - 1, Math.max(1, (now.getTime() - HOUR_MS - firstAt) / HOUR_MS))
    : 7 * 24 - 1;

  return {
    lastHour,
    baselinePerHour: beforeCount / spanHours,
    rateLimited,
    breakerOpens,
    topOperations: [...byOp.entries()]
      .map(([operation, c]) => ({ operation, count: c }))
      .sort((a, b) => b.count - a.count || a.operation.localeCompare(b.operation))
      .slice(0, 3),
  };
}

/** The Redis call the dedupe makes - narrow so tests need no server. */
export interface VolumeAlertRedis {
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<unknown>;
}

export interface YijiVolumeCheckDeps {
  directus: YijiDirectusClient;
  notificationsQueue: Pick<Queue, 'add'>;
  redis?: VolumeAlertRedis;
  logger: Pick<Logger, 'info' | 'warn'>;
  thresholds?: YijiVolumeThresholds;
  now?: () => Date;
  /** Who to tell; defaults to the active Administrator accounts. */
  recipients?: () => Promise<string[]>;
  /** Defaults to `readYijiVolumeFacts`. */
  readFacts?: (now: Date) => Promise<YijiVolumeFacts>;
}

export type YijiVolumeCheckResult = 'quiet' | 'alerted' | 'deduped' | 'no-recipient' | 'failed';

export async function runYijiVolumeCheck(
  deps: YijiVolumeCheckDeps,
): Promise<YijiVolumeCheckResult> {
  const now = deps.now?.() ?? new Date();
  let facts: YijiVolumeFacts;
  try {
    facts = await (deps.readFacts ?? ((d) => readYijiVolumeFacts(deps.directus, d)))(now);
  } catch (err) {
    /* A missed check is caught by the next one in 15 minutes. */
    deps.logger.warn({ err: errorText(err) }, 'yiji volume check could not read usage');
    return 'failed';
  }
  const verdict = yijiVolumeVerdict(facts, deps.thresholds);
  if (!verdict.alert) return 'quiet';

  deps.logger.warn({ ...facts, reasons: verdict.reasons }, 'yiji call volume alert');
  if (deps.redis) {
    try {
      const ok = await deps.redis.set(
        envKey('yiji-volume-alert'),
        now.toISOString(),
        'EX',
        DEDUPE_SEC,
        'NX',
      );
      if (ok !== 'OK') return 'deduped';
    } catch {
      /* Rather alert twice than not at all. */
    }
  }

  let recipients: string[];
  try {
    recipients = deps.recipients
      ? await deps.recipients()
      : (
          (await deps.directus.request(
            readUsers({
              filter: { status: { _eq: 'active' }, role: { name: { _in: [...ALERT_ROLES] } } },
              fields: ['id'],
              limit: -1,
            } as never) as never,
          )) as unknown as Array<{ id: string }>
        ).map((u) => u.id);
  } catch (err) {
    deps.logger.warn({ err: errorText(err) }, 'yiji volume alert: recipients could not be read');
    return 'failed';
  }
  if (recipients.length === 0) {
    deps.logger.warn({}, 'yiji volume alert: nobody to tell - no active Administrator');
    return 'no-recipient';
  }

  const top = facts.topOperations.map((o) => `${o.operation}: ${o.count}`).join(', ');
  const body = `${verdict.reasons.join('; ')}.${top ? ` Busiest: ${top}.` : ''} See Admin KPI -> Yiji API usage.`;
  const hour = Math.floor(now.getTime() / HOUR_MS);
  await Promise.all(
    recipients.map((recipientId) =>
      deps.notificationsQueue.add(
        YIJI_VOLUME_ALERT_JOB,
        {
          recipientId,
          type: 'automation',
          title: 'Unusual Yiji API traffic',
          body,
          link: ADMIN_KPI_LINK,
          payload: { kind: 'yiji_volume_alert', ...facts },
        } satisfies NotificationJob,
        { jobId: `yiji-volume-${hour}-${recipientId}` },
      ),
    ),
  );
  return 'alerted';
}

/** One job scheduler, however many worker tasks (like the usage retention). `0` removes it. */
export async function scheduleYijiVolumeAlert(queue: Queue, everyMs: number): Promise<void> {
  if (!(everyMs > 0)) {
    await queue.removeJobScheduler(SCHEDULER);
    return;
  }
  await queue.upsertJobScheduler(
    SCHEDULER,
    { every: everyMs },
    {
      name: YIJI_VOLUME_ALERT_JOB,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}
