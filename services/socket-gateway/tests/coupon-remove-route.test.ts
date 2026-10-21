import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * EMA-80: POST /jobs/coupon-remove takes a ticket's coupon back. Read from the
 * source like the other route guards here: the route must be gated on the
 * permission, and WHO removed it must come from the verified token - never
 * from the request body.
 */
const read = (rel: string) => {
  const path = [rel, `services/socket-gateway/${rel}`].find((p) => existsSync(p));
  return readFileSync(path!, 'utf8');
};
const INDEX = read('src/index.ts');
const QUEUE = read('src/queue.ts');

const route = (() => {
  const start = INDEX.indexOf("app.post('/jobs/coupon-remove'");
  expect(start).toBeGreaterThan(0);
  return INDEX.slice(start, INDEX.indexOf('\n  });', start));
})();

describe('/jobs/coupon-remove', () => {
  it('is gated on manage_ticket_compensation', () => {
    expect(route).toMatch(/requirePrivilege\(req, reply, 'manage_ticket_compensation'\)/);
  });

  it('takes removedBy from the verified identity, not the body', () => {
    expect(route).toMatch(/omit\(\{ removedBy: true \}\)/);
    expect(route).toMatch(/removedBy: identity\.id/);
  });

  it('queues the worker job by NAME, without a custom jobId (BullMQ swallows re-adds)', () => {
    const fn = QUEUE.slice(QUEUE.indexOf('async enqueueCouponRemove(job'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).toMatch(/this\.coupons\.add\(COUPON_REMOVE_JOB_NAME/);
    expect(body).not.toMatch(/^\s*jobId:/m);
  });
});
