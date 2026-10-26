import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_YIJI_VOLUME_THRESHOLDS,
  readYijiVolumeFacts,
  runYijiVolumeCheck,
  scheduleYijiVolumeAlert,
  yijiVolumeThresholdsFromEnv,
  yijiVolumeVerdict,
  type YijiVolumeFacts,
} from '../src/processors/yiji-volume-alert.js';

const quiet: YijiVolumeFacts = {
  lastHour: 150,
  baselinePerHour: 140,
  rateLimited: 0,
  breakerOpens: 0,
  topOperations: [{ operation: 'order.late_poll', count: 60 }],
};
const logger = { info: vi.fn(), warn: vi.fn() };

describe('yijiVolumeVerdict', () => {
  it('a normal hour is quiet', () => {
    expect(yijiVolumeVerdict(quiet)).toEqual({ alert: false, reasons: [] });
  });

  it('the 2026-10-26 flood alerts (~9,000 calls an hour against ~140)', () => {
    const v = yijiVolumeVerdict({ ...quiet, lastHour: 9_100 });
    expect(v.alert).toBe(true);
    expect(v.reasons[0]).toContain('9100');
  });

  it('more than double the baseline alerts - but only above the floor', () => {
    expect(yijiVolumeVerdict({ ...quiet, lastHour: 600, baselinePerHour: 200 }).alert).toBe(true);
    /* A quiet night tripling (30 -> 90) is not news. */
    expect(yijiVolumeVerdict({ ...quiet, lastHour: 90, baselinePerHour: 30 }).alert).toBe(false);
    /* Busy but in line with the week. */
    expect(yijiVolumeVerdict({ ...quiet, lastHour: 700, baselinePerHour: 400 }).alert).toBe(false);
  });

  it('any 429 or breaker opening alerts, whatever the volume', () => {
    expect(yijiVolumeVerdict({ ...quiet, rateLimited: 1 }).reasons[0]).toContain('429');
    expect(yijiVolumeVerdict({ ...quiet, breakerOpens: 1 }).alert).toBe(true);
  });

  it('thresholds come from env, junk ignored', () => {
    expect(
      yijiVolumeThresholdsFromEnv({ YIJI_ALERT_MAX_PER_HOUR: '3000', YIJI_ALERT_FACTOR: 'x' }),
    ).toEqual({ ...DEFAULT_YIJI_VOLUME_THRESHOLDS, maxPerHour: 3000 });
  });
});

describe('readYijiVolumeFacts', () => {
  it('sums the last hour by operation, separates 429s and guard rows, averages the week', async () => {
    const now = new Date('2026-10-26T13:00:00Z');
    const request = vi
      .fn()
      .mockResolvedValueOnce([
        { operation: 'customer.lookup', http_status: 200, count: '3000' },
        { operation: 'customer.lookup', http_status: 429, count: '400' },
        { operation: 'order.late_poll', http_status: 200, count: 60 },
        { operation: 'guard.breaker', http_status: 429, count: '2' },
      ])
      .mockResolvedValueOnce([{ count: '23000' }])
      /* Rows only go back ~4 days: the average is over the span that exists. */
      .mockResolvedValueOnce([{ date_created: '2026-10-22T12:00:00Z' }]);
    const f = await readYijiVolumeFacts({ request } as never, now);
    expect(f.lastHour).toBe(3_460);
    expect(f.rateLimited).toBe(400);
    expect(f.breakerOpens).toBe(2);
    expect(f.baselinePerHour).toBeCloseTo(23_000 / 96, 5);
    expect(f.topOperations[0]).toEqual({ operation: 'customer.lookup', count: 3_400 });
  });
});

describe('runYijiVolumeCheck', () => {
  const flood: YijiVolumeFacts = {
    ...quiet,
    lastHour: 9_100,
    rateLimited: 120,
    topOperations: [{ operation: 'customer.lookup', count: 8_900 }],
  };
  const base = (facts: YijiVolumeFacts) => {
    const add = vi.fn(async () => undefined);
    return {
      add,
      deps: {
        directus: {} as never,
        notificationsQueue: { add } as never,
        logger,
        readFacts: async () => facts,
        recipients: async () => ['owner-1'],
        now: () => new Date('2026-10-26T13:10:00Z'),
      },
    };
  };

  it('quiet: nobody is told', async () => {
    const { add, deps } = base(quiet);
    expect(await runYijiVolumeCheck(deps)).toBe('quiet');
    expect(add).not.toHaveBeenCalled();
  });

  it('a flood: the Administrator is told in-app, naming the busiest operation', async () => {
    const { add, deps } = base(flood);
    expect(await runYijiVolumeCheck(deps)).toBe('alerted');
    expect(add).toHaveBeenCalledTimes(1);
    const [, job, opts] = add.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { jobId: string },
    ];
    expect(job).toMatchObject({
      recipientId: 'owner-1',
      type: 'automation',
      link: '/reports/admin-kpi',
    });
    expect(String(job.body)).toContain('customer.lookup: 8900');
    expect(String(job.body)).toContain('429');
    expect(opts.jobId).toMatch(/^yiji-volume-\d+-owner-1$/);
  });

  it('one alert per three hours: the dedupe key holds the next one', async () => {
    const keys = new Map<string, string>();
    const redis = {
      set: vi.fn(async (k: string, v: string) => {
        if (keys.has(k)) return null;
        keys.set(k, v);
        return 'OK';
      }),
    };
    const first = base(flood);
    expect(await runYijiVolumeCheck({ ...first.deps, redis })).toBe('alerted');
    const second = base(flood);
    expect(await runYijiVolumeCheck({ ...second.deps, redis })).toBe('deduped');
    expect(second.add).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'EX',
      10_800,
      'NX',
    );
  });

  it('a Redis that cannot dedupe still alerts', async () => {
    const { add, deps } = base(flood);
    const redis = { set: vi.fn(async () => Promise.reject(new Error('down'))) };
    expect(await runYijiVolumeCheck({ ...deps, redis })).toBe('alerted');
    expect(add).toHaveBeenCalled();
  });

  it('says so when there is nobody to tell (never a silent alert)', async () => {
    const { deps } = base(flood);
    expect(await runYijiVolumeCheck({ ...deps, recipients: async () => [] })).toBe('no-recipient');
    expect(logger.warn).toHaveBeenCalledWith({}, expect.stringContaining('nobody to tell'));
  });

  it('reads the Administrators by role NAME when no recipients are given', async () => {
    const add = vi.fn(async () => undefined);
    const request = vi.fn(async () => [{ id: 'admin-1' }, { id: 'admin-2' }]);
    const r = await runYijiVolumeCheck({
      directus: { request } as never,
      notificationsQueue: { add } as never,
      logger,
      readFacts: async () => flood,
    });
    expect(r).toBe('alerted');
    expect(add).toHaveBeenCalledTimes(2);
  });

  it('a usage read that fails is logged, not thrown (the next run tries again)', async () => {
    const { deps } = base(flood);
    expect(
      await runYijiVolumeCheck({
        ...deps,
        readFacts: () => Promise.reject(new Error('directus down')),
      }),
    ).toBe('failed');
  });
});

describe('scheduleYijiVolumeAlert', () => {
  it('upserts one scheduler; 0 removes it', async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn() };
    await scheduleYijiVolumeAlert(queue as never, 900_000);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'yiji-volume-alert',
      { every: 900_000 },
      expect.objectContaining({ name: 'yiji_volume_alert' }),
    );
    await scheduleYijiVolumeAlert(queue as never, 0);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('yiji-volume-alert');
  });
});
