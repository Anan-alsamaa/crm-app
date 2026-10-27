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

const route = (() => {
  const start = INDEX.indexOf("app.post('/jobs/coupon-replace'");
  expect(start).toBeGreaterThan(0);
  return INDEX.slice(start, INDEX.indexOf('\n  });', start));
})();

describe('/jobs/coupon-replace', () => {
  it('is gated on edit_approved_coupons', () => {
    expect(route).toMatch(/requirePrivilege\(req, reply, 'edit_approved_coupons'\)/);
  });

  it('takes editedBy from the verified identity, not the body', () => {
    expect(route).toMatch(/omit\(\{ editedBy: true \}\)/);
    expect(route).toMatch(/editedBy: identity\.id/);
  });

  it('refuses a coupon that names itself as its own replacement', () => {
    expect(route).toMatch(/couponApprovalId === parsed\.data\.replacementId/);
  });

  it('queues the worker job by NAME, without a custom jobId (BullMQ swallows re-adds)', () => {
    const fn = QUEUE.slice(QUEUE.indexOf('async enqueueCouponReplace(job'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/this\.coupons\.add\(COUPON_REPLACE_JOB_NAME/);
    expect(body).not.toMatch(/^\s*jobId:/m);
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
