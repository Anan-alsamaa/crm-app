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

const routeOf = (path: string) => {
  const start = INDEX.indexOf(`app.post('${path}'`);
  expect(start).toBeGreaterThan(0);
  const next = INDEX.indexOf('app.post(', start + 10);
  return INDEX.slice(start, next > 0 ? next : undefined);
};

/* REPLACING (remove + issue a new code) was removed for good (owner,
   2026-11-12): refused for everyone, nothing queued. */
describe('replacing a coupon stays removed', () => {
  it('/jobs/coupon-replace answers 410 to everyone and queues nothing', () => {
    const r = routeOf('/jobs/coupon-replace');
    expect(r).toMatch(/reply\.code\(410\)/);
    expect(r.slice(0, r.indexOf('\n  );'))).not.toMatch(/enqueue/);
    expect(INDEX).not.toMatch(/enqueueCouponReplace\(/);
    expect(QUEUE).toMatch(/async enqueueCouponReplace/); // the queue method may stay, unused
  });
});

/* EDIT IN PLACE is back, made safe (owner, 2026-11-12). */
describe('editing an approved coupon in place', () => {
  it('is gated on its own privilege and takes WHO from the token, never the body', () => {
    const r = routeOf('/jobs/coupon-edit');
    expect(r).toMatch(/requirePrivilege\(req, reply, 'edit_approved_coupons'\)/);
    expect(r).toMatch(/CouponEditJob\.omit\(\{ editedBy: true \}\)/);
    expect(r).toMatch(/editedBy: identity\.id/);
    expect(r).toMatch(/enqueueCouponEdit\(/);
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
