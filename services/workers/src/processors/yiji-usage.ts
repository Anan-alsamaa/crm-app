import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { createItems, deleteItems, readItems } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { YIJI_USAGE_RETENTION_DAYS, errorText, type YijiUsageRow } from '@yiji/shared-types';

/**
 * `yiji_api_usage` - the workers' half (owner, 2026-10-21).
 *
 * The workers WRITE their own Yiji calls (coupon push, removal, customer push,
 * the late-orders poll) like every service, and they alone DELETE: the
 * retention job below keeps the log at `YIJI_USAGE_RETENTION_DAYS` (90). A
 * once-a-minute poll alone is ~1,440 rows a day, so an unbounded log would be
 * the next audit-trail growth problem (memory: storage-architecture).
 */

export const YIJI_USAGE_COLLECTION = 'yiji_api_usage';
/** Job name on the automation queue, next to the inactivity sweep. */
export const YIJI_USAGE_RETENTION_JOB = 'yiji_usage_retention';
const RETENTION_SCHEDULER = 'yiji-usage-retention';
/** Once a day is plenty: the cut-off moves by one day a day. */
export const DEFAULT_YIJI_USAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The recorder's writer: one batched insert. Throws on failure (the recorder reports it). */
export function yijiUsageWriter(directus: YijiDirectusClient) {
  return async (rows: YijiUsageRow[]): Promise<void> => {
    if (rows.length === 0) return;
    await directus.request(createItems(YIJI_USAGE_COLLECTION as never, rows as never));
  };
}

/**
 * Repeatable, ONE job however many worker tasks run (a job scheduler, like the
 * late-orders poll). `0` removes it. On the automation queue rather than the
 * reports queue: the scheduled-reports sync removes every scheduler there that
 * is not a report.
 */
export async function scheduleYijiUsageRetention(queue: Queue, everyMs: number): Promise<void> {
  if (!(everyMs > 0)) {
    await queue.removeJobScheduler(RETENTION_SCHEDULER);
    return;
  }
  await queue.upsertJobScheduler(
    RETENTION_SCHEDULER,
    { every: everyMs },
    {
      name: YIJI_USAGE_RETENTION_JOB,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}

export interface YijiUsagePurgeDeps {
  directus: YijiDirectusClient;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  days?: number;
  /** Ids per delete. Keys go in the request BODY, so no 414 (memory: cloudfront-414). */
  batchSize?: number;
  /** Safety stop for one run; the next run continues. */
  maxBatches?: number;
}

/** Delete rows older than the retention window. Returns how many went. */
export async function purgeYijiUsage(deps: YijiUsagePurgeDeps): Promise<number> {
  const days = deps.days ?? YIJI_USAGE_RETENTION_DAYS;
  const batchSize = deps.batchSize ?? 1_000;
  const maxBatches = deps.maxBatches ?? 50;
  const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000);
  let deleted = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const rows = (await deps.directus.request(
        readItems(
          YIJI_USAGE_COLLECTION as never,
          {
            fields: ['id'],
            filter: { date_created: { _lt: cutoff.toISOString() } },
            limit: batchSize,
          } as never,
        ),
      )) as unknown as Array<{ id: string | number }>;
      const ids = (rows ?? []).map((r) => r.id).filter((v) => v !== null && v !== undefined);
      if (ids.length === 0) break;
      await deps.directus.request(
        deleteItems(YIJI_USAGE_COLLECTION as never, ids.map(String) as never),
      );
      deleted += ids.length;
      if (ids.length < batchSize) break;
    }
  } catch (err) {
    /* Housekeeping: a failed purge waits for tomorrow's run, it never fails loudly. */
    deps.logger.warn({ err: errorText(err), deleted }, 'yiji usage retention purge failed');
    return deleted;
  }
  deps.logger.info({ deleted, olderThan: cutoff.toISOString() }, 'yiji usage retention purge');
  return deleted;
}
