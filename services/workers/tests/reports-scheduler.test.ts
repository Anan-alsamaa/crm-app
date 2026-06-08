import { describe, it, expect, vi } from 'vitest';
import { syncScheduledReports } from '../src/processors/reports.js';

/**
 * Exercises the scheduled-reports reconciler: it should register one BullMQ
 * Job Scheduler per report that has a `schedule.cron`, skip reports without one,
 * prune stale `report:*` schedulers, and survive an invalid cron. No live Redis
 * / Directus — the queue + directus client are mocked.
 */
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function makeQueue(existing: Array<{ key: string }> = []) {
  return {
    upsertJobScheduler: vi.fn(async () => undefined),
    getJobSchedulers: vi.fn(async () => existing),
    removeJobScheduler: vi.fn(async () => undefined),
  };
}

const makeDirectus = (rows: unknown) => ({ request: vi.fn(async () => rows) }) as never;

describe('syncScheduledReports', () => {
  it('registers a scheduler only for reports with a non-empty cron', async () => {
    const directus = makeDirectus([
      { id: 'r1', schedule: { cron: '0 9 * * 1', email: ['a@x.com'] } },
      { id: 'r2', schedule: { email: ['b@x.com'] } }, // no cron
      { id: 'r3', schedule: null },
      { id: 'r4', schedule: { cron: '   ' } }, // blank → ignored
    ]);
    const queue = makeQueue();

    const res = await syncScheduledReports(queue as never, { directus, logger });

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'report:r1',
      { pattern: '0 9 * * 1' },
      { name: 'scheduled-report', data: { reportId: 'r1' } },
    );
    expect(res).toEqual({ active: 1, removed: 0 });
  });

  it('prunes stale report schedulers and leaves unrelated ones', async () => {
    const directus = makeDirectus([{ id: 'r1', schedule: { cron: '* * * * *' } }]);
    const queue = makeQueue([
      { key: 'report:r1' }, // still wanted → keep
      { key: 'report:OLD' }, // gone → remove
      { key: 'sla:reconcile' }, // not ours → leave
    ]);

    const res = await syncScheduledReports(queue as never, { directus, logger });

    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('report:OLD');
    expect(res).toEqual({ active: 1, removed: 1 });
  });

  it('skips an invalid cron without aborting the sweep', async () => {
    const directus = makeDirectus([
      { id: 'good', schedule: { cron: '0 0 * * *' } },
      { id: 'bad', schedule: { cron: 'not-a-cron' } },
    ]);
    const queue = makeQueue();
    queue.upsertJobScheduler.mockImplementation(async (id: string) => {
      if (id === 'report:bad') throw new Error('invalid cron expression');
    });

    const res = await syncScheduledReports(queue as never, { directus, logger });

    expect(res).toEqual({ active: 1, removed: 0 });
  });
});
