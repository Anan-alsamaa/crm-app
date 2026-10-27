import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { YijiRefusedError, YijiUnavailableError, type CouponReplaceJob } from '@yiji/shared-types';
import { processCouponReplaceJob } from '../src/processors/coupon-replace.js';
import { replacementBlocksPush } from '../src/processors/coupon-push.js';
import type { YijiCouponRemover } from '../src/lib/yiji-coupon-remover.js';

/**
 * EDIT AN APPROVED COUPON = REPLACE IT (owner, 2026-10-27). The worker side:
 * a used coupon is refused, the old one is taken out of the customer's app
 * BEFORE the new one is released, and every refusal rolls back. No test here
 * talks to Yiji - every call is a mock.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ op: 'readItems', collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({
    op: 'readItem',
    collection,
    id,
    opts,
  }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    op: 'updateItem',
    collection,
    id,
    payload,
  }),
  createItem: (collection: string, payload: unknown) => ({ op: 'createItem', collection, payload }),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

type Req = {
  op: string;
  collection: string;
  id?: string;
  opts?: { fields?: unknown[]; filter?: unknown };
  payload?: Record<string, unknown>;
};

const OLD = {
  id: 'old-1',
  status: 'assigned',
  coupon_code: 'OPS-OLD11111',
  title: '+966501234567',
  customer_phone: null,
  ticket: { id: 't1' },
  contact: { phone: '0501234567', external_customer_id: 'yiji-user-1' },
  yiji_coupon_user_id: '27507',
  removal_status: null as string | null,
  removal_detail: null as string | null,
  replaced_by: null as string | null,
};

const NEW = {
  id: 'new-1',
  status: 'approved',
  coupon_code: 'OPS-NEW22222',
  coupon_value: '40',
  coupon_percent: null,
  max_discount: '40',
  discount_category: 'Amount',
  compensation: 'Compensated',
  replaces: 'old-1',
  decided_by: 'sup-1',
  user_created: 'sup-1',
  ticket: { id: 't1' },
};

/** A Directus fake holding the two coupon rows; every write recorded and applied. */
function fakeDirectus(
  over: { old?: Partial<typeof OLD>; fresh?: Partial<typeof NEW> | null } = {},
) {
  const rows: Record<string, Record<string, unknown>> = {
    'old-1': { ...OLD, ...(over.old ?? {}) },
  };
  if (over.fresh !== null) rows['new-1'] = { ...NEW, ...(over.fresh ?? {}) };
  const writes: Array<{
    op: string;
    collection: string;
    id?: string;
    payload: Record<string, unknown>;
  }> = [];
  const request = vi.fn(async (r: Req) => {
    if (r.op === 'readItem') {
      if (r.collection === 'directus_users') return { first_name: 'Sara', email: 's@x' };
      const row = rows[r.id!];
      if (!row) throw { errors: [{ message: 'FORBIDDEN', extensions: { code: 'FORBIDDEN' } }] };
      return { ...row };
    }
    if (r.op === 'readItems') {
      // syncTicketCompensation: the ticket's coupons.
      return Object.values(rows).map((x) => ({
        id: x.id,
        status: x.status,
        removal_status: x.removal_status ?? null,
      }));
    }
    if (r.op === 'updateItem') {
      writes.push({ op: r.op, collection: r.collection, id: r.id, payload: r.payload! });
      if (r.collection === 'coupon_approvals') Object.assign(rows[r.id!]!, r.payload);
      return {};
    }
    if (r.op === 'createItem') {
      writes.push({ op: r.op, collection: r.collection, payload: r.payload! });
      return {};
    }
    throw new Error(`unexpected ${r.op}`);
  });
  return { directus: { request } as never, writes, rows };
}

function remover(over: Partial<YijiCouponRemover> = {}) {
  let held = ['27507', '99'];
  return {
    findCustomer: vi.fn(async () => 'yiji-user-1'),
    wallet: vi.fn(async () => ({ held: [...held], active: [...held] })),
    usedOnOrder: vi.fn(async () => null),
    removeGrant: vi.fn(async (g: string) => {
      held = held.filter((x) => x !== g);
    }),
    ...over,
  } satisfies YijiCouponRemover;
}

const job = (attemptsMade = 0, attempts = 5) =>
  ({
    data: {
      couponApprovalId: 'old-1',
      replacementId: 'new-1',
      editedBy: 'sup-1',
      reason: 'Wrong amount',
    },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job<CouponReplaceJob>;

describe('a delivered coupon, edited', () => {
  it('checks it was not used, claims it, takes it out of the app, then releases the new one', async () => {
    const { directus, writes, rows } = fakeDirectus();
    const y = remover();
    const enqueuePush = vi.fn(async () => ({}));
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: y, enqueuePush });

    expect(out).toBe('replaced');
    // Used? asked for THIS coupon's grant only.
    expect(y.usedOnOrder).toHaveBeenCalledWith('yiji-user-1', '27507');
    expect(y.removeGrant).toHaveBeenCalledWith('27507');
    // The old row is history: claimed and verified removed.
    expect(rows['old-1']).toMatchObject({
      replaced_by: 'new-1',
      replace_reason: 'Wrong amount',
      removal_status: 'removed',
    });
    // The new one is untouched (still approved) and its delivery queued.
    expect(rows['new-1']!.status).toBe('approved');
    expect(enqueuePush).toHaveBeenCalledWith('new-1');
    // The ticket carries the NEW coupon.
    const ticket = writes.filter((w) => w.collection === 'tickets').at(-1)?.payload;
    expect(ticket).toMatchObject({
      coupon_code: 'OPS-NEW22222',
      coupon_value: 40,
      compensation: 'Compensated',
    });
    // One history line on the ticket.
    const events = writes.filter((w) => w.collection === 'ticket_events');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      ticket: 't1',
      event_type: 'commented',
      actor: 'sup-1',
    });
    expect(String((events[0]!.payload.payload as { text: string }).text)).toBe(
      'Coupon OPS-OLD11111 replaced by OPS-NEW22222 by Sara: Wrong amount',
    );
  });

  it('claims BEFORE removing, so the push hold never sees an unclaimed removal', async () => {
    const { directus, writes } = fakeDirectus();
    await processCouponReplaceJob(job(), { directus, logger, remover: remover() });
    const claimAt = writes.findIndex((w) => w.payload.replaced_by === 'new-1');
    const removeAt = writes.findIndex((w) => w.payload.removal_status === 'pending');
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(claimAt).toBeLessThan(removeAt);
  });
});

describe('a coupon the customer already USED', () => {
  it('is refused before anything changes: the old one stays, the new one is rolled back', async () => {
    const { directus, rows } = fakeDirectus();
    const y = remover({ usedOnOrder: vi.fn(async () => '1234567') });
    const enqueuePush = vi.fn();
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: y, enqueuePush });

    expect(out).toBe('used');
    expect(y.removeGrant).not.toHaveBeenCalled();
    expect(rows['old-1']).toMatchObject({ replaced_by: null, removal_status: null });
    expect(rows['new-1']!.status).toBe('rejected');
    expect(String(rows['new-1']!.decision_note)).toMatch(
      /already used OPS-OLD11111 on order 1234567/,
    );
    expect(enqueuePush).not.toHaveBeenCalled();
  });

  it('is refused straight away when the card already knows it was used', async () => {
    const { directus, rows } = fakeDirectus({ old: { removal_status: 'used' } });
    const y = remover();
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: y });
    expect(out).toBe('used');
    expect(y.usedOnOrder).not.toHaveBeenCalled();
    expect(rows['new-1']!.status).toBe('rejected');
  });
});

describe('when the old coupon cannot be taken out', () => {
  it('Yiji refuses the removal: rolled back, claim cleared, nothing delivered', async () => {
    const { directus, rows } = fakeDirectus();
    const y = remover({
      removeGrant: vi.fn(async () => {
        throw new YijiRefusedError('refused', 403, { message: 'nope' });
      }),
    });
    const enqueuePush = vi.fn();
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: y, enqueuePush });

    expect(out).toBe('failed');
    expect(rows['old-1']!.replaced_by).toBeNull();
    expect(rows['old-1']!.removal_status).toBe('failed');
    expect(rows['new-1']!.status).toBe('rejected');
    expect(String(rows['new-1']!.decision_note)).toMatch(/could not be taken out/);
    expect(enqueuePush).not.toHaveBeenCalled();
  });

  it('Yiji unreachable: retried (throws) until the LAST attempt, which rolls back', async () => {
    const down = () =>
      remover({
        usedOnOrder: vi.fn(async () => {
          throw new YijiUnavailableError('timeout');
        }),
      });
    const a = fakeDirectus();
    await expect(
      processCouponReplaceJob(job(0, 5), { directus: a.directus, logger, remover: down() }),
    ).rejects.toThrow();
    expect(a.rows['new-1']!.status).toBe('approved'); // untouched, a retry follows

    const b = fakeDirectus();
    const out = await processCouponReplaceJob(job(4, 5), {
      directus: b.directus,
      logger,
      remover: down(),
    });
    expect(out).toBe('failed');
    expect(b.rows['new-1']!.status).toBe('rejected');
    expect(b.rows['old-1']!.replaced_by).toBeNull();
  });

  it('no Yiji removal configured: a coupon in the app is refused, nothing changes', async () => {
    const { directus, rows } = fakeDirectus();
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: null });
    expect(out).toBe('failed');
    expect(rows['new-1']!.status).toBe('rejected');
    expect(rows['old-1']!.replaced_by).toBeNull();
  });
});

describe('a coupon that never reached the app', () => {
  it('is replaced in the CRM only - no Yiji call at all', async () => {
    const { directus, rows } = fakeDirectus({
      old: { status: 'approved', yiji_coupon_user_id: null },
    });
    const y = remover();
    const enqueuePush = vi.fn(async () => ({}));
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: y, enqueuePush });
    expect(out).toBe('replaced');
    expect(y.usedOnOrder).not.toHaveBeenCalled();
    expect(y.removeGrant).not.toHaveBeenCalled();
    expect(rows['old-1']!.removal_status).toBe('not_on_yiji');
    expect(enqueuePush).toHaveBeenCalledWith('new-1');
  });
});

describe('guards and retries', () => {
  it('never touches a row that is not this coupon’s replacement', async () => {
    const { directus, writes } = fakeDirectus({ fresh: { replaces: 'someone-else' } });
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: remover() });
    expect(out).toBe('refused');
    expect(writes).toHaveLength(0);
  });

  it('refuses a replacement not created by the verified editor', async () => {
    const { directus, rows } = fakeDirectus({
      fresh: { user_created: 'agent-9', decided_by: 'agent-9' },
    });
    const y = remover();
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: y });
    expect(out).toBe('refused');
    expect(rows['new-1']!.status).toBe('rejected');
    expect(y.removeGrant).not.toHaveBeenCalled();
  });

  it('a coupon already replaced by ANOTHER edit: this edit is rolled back', async () => {
    const { directus, rows } = fakeDirectus({ old: { replaced_by: 'new-0' } });
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: remover() });
    expect(out).toBe('refused');
    expect(rows['new-1']!.status).toBe('rejected');
    expect(rows['old-1']!.replaced_by).toBe('new-0');
  });

  it('a rejected / removed original cannot be edited', async () => {
    for (const old of [{ status: 'rejected' }, { removal_status: 'removed' }]) {
      const { directus, rows } = fakeDirectus({ old });
      const out = await processCouponReplaceJob(job(), { directus, logger, remover: remover() });
      expect(out).toBe('refused');
      expect(rows['new-1']!.status).toBe('rejected');
    }
  });

  it('a retry after a finished run resumes without a second history line or removal', async () => {
    const { directus, writes } = fakeDirectus({
      old: { replaced_by: 'new-1', removal_status: 'removed' },
    });
    const y = remover();
    const enqueuePush = vi.fn(async () => ({}));
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: y, enqueuePush });
    expect(out).toBe('replaced');
    expect(y.removeGrant).not.toHaveBeenCalled();
    expect(y.usedOnOrder).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.collection === 'ticket_events')).toHaveLength(0);
    expect(enqueuePush).toHaveBeenCalledWith('new-1');
  });

  it('an already rolled-back edit just clears a left-over claim', async () => {
    const { directus, rows } = fakeDirectus({
      old: { replaced_by: 'new-1' },
      fresh: { status: 'rejected' },
    });
    const out = await processCouponReplaceJob(job(), { directus, logger, remover: remover() });
    expect(out).toBe('refused');
    expect(rows['old-1']!.replaced_by).toBeNull();
  });

  it('a missing row does nothing', async () => {
    const { directus, writes } = fakeDirectus({ fresh: null });
    expect(await processCouponReplaceJob(job(), { directus, logger, remover: remover() })).toBe(
      'not-found',
    );
    expect(writes).toHaveLength(0);
  });
});

describe('the push hold', () => {
  const directusWith = (rows: Record<string, Record<string, unknown>>) =>
    ({
      request: vi.fn(async (r: Req) => {
        const row = rows[r.id!];
        if (!row) throw { errors: [{ message: 'FORBIDDEN' }] };
        return row;
      }),
    }) as never;

  it('holds a replacement until the old one is claimed AND removed', async () => {
    const pending = directusWith({
      'new-1': { replaces: 'old-1', replaced_by: null },
      'old-1': { replaced_by: 'new-1', removal_status: 'pending' },
    });
    expect(await replacementBlocksPush(pending, 'new-1', logger)).toBe(true);
    const unclaimed = directusWith({
      'new-1': { replaces: 'old-1', replaced_by: null },
      'old-1': { replaced_by: null, removal_status: null },
    });
    expect(await replacementBlocksPush(unclaimed, 'new-1', logger)).toBe(true);
    const released = directusWith({
      'new-1': { replaces: 'old-1', replaced_by: null },
      'old-1': { replaced_by: 'new-1', removal_status: 'removed' },
    });
    expect(await replacementBlocksPush(released, 'new-1', logger)).toBe(false);
  });

  it('never sends a coupon that was replaced', async () => {
    const d = directusWith({ 'old-1': { replaces: null, replaced_by: 'new-1' } });
    expect(await replacementBlocksPush(d, 'old-1', logger)).toBe(true);
  });

  it('an ordinary coupon is not held - and fields not applied yet mean "no"', async () => {
    expect(
      await replacementBlocksPush(
        directusWith({ c: { replaces: null, replaced_by: null } }),
        'c',
        logger,
      ),
    ).toBe(false);
    const missing = {
      request: vi.fn(async () => {
        throw {
          errors: [
            {
              message: "You don't have permission to access field replaces",
              extensions: { code: 'FORBIDDEN' },
            },
          ],
        };
      }),
    } as never;
    expect(await replacementBlocksPush(missing, 'c', logger)).toBe(false);
  });
});
