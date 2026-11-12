import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPerformanceDataset, type ServiceRead } from '../src/performance-report.js';

/**
 * Owner, 2026-10-27: POST /jobs/coupon-replace hands an edited APPROVED coupon
 * to the workers. Read from the source like the other route guards here: the
 * route must be gated on its own permission, and WHO edited must come from the
 * verified token - never from the request body.
 */
const read = (rel: string) => {
  const path = [rel, `services/socket-gateway/${rel}`].find((p) => existsSync(p));
  return readFileSync(path!, 'utf8');
};
const INDEX = read('src/index.ts');
const QUEUE = read('src/queue.ts');

/* EDIT AN APPROVED COUPON was REMOVED (owner, 2026-11-12): both entry points
   refuse everyone and queue nothing. */
const routeOf = (path: string) => {
  const start = INDEX.indexOf(`app.post('${path}'`);
  expect(start).toBeGreaterThan(0);
  return INDEX.slice(start, INDEX.indexOf('\n  );', start) + 5);
};

describe('editing an approved coupon was removed', () => {
  for (const path of ['/jobs/coupon-replace', '/jobs/coupon-edit']) {
    it(`${path} answers 410 to everyone and queues nothing`, () => {
      const r = routeOf(path);
      expect(r).toMatch(/reply\.code\(410\)/);
      expect(r).not.toMatch(/enqueue/);
      expect(r).not.toMatch(/requirePrivilege/);
    });
  }
  it('the gateway no longer queues edit or replace jobs anywhere', () => {
    expect(INDEX).not.toMatch(/enqueueCouponReplace\(|enqueueCouponEdit\(/);
    expect(QUEUE).toMatch(/async enqueueCouponReplace/); // the queue method may stay, unused
  });
});

describe('agent performance: an edited coupon is one request', () => {
  it('drops the replaced row and an abandoned edit from the coupons dataset', async () => {
    const reads: Array<Record<string, unknown>> = [];
    const svc: ServiceRead = async (_collection, query) => {
      reads.push(query);
      if ((query.filter as { _or?: unknown } | undefined)?._or) {
        return [
          { id: 'old', status: 'assigned', replaces: null, replaced_by: 'new' },
          { id: 'new', status: 'approved', replaces: 'old', replaced_by: null },
          { id: 'gave-up', status: 'rejected', replaces: 'x', replaced_by: null },
        ];
      }
      return [{ id: 'old' }, { id: 'new' }, { id: 'gave-up' }, { id: 'plain' }];
    };
    const rows = (await readPerformanceDataset(svc, {
      dataset: 'coupons',
      filters: {},
    })) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['new', 'plain']);
  });

  it('a missing field (not applied yet) leaves the dataset exactly as before', async () => {
    const svc: ServiceRead = async (_c, query) => {
      if ((query.filter as { _or?: unknown } | undefined)?._or) throw new Error('FORBIDDEN');
      return [{ id: 'a' }, { id: 'b' }];
    };
    const rows = (await readPerformanceDataset(svc, { dataset: 'coupons', filters: {} })) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
