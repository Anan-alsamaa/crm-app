import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { couponTermsVersion, type CouponEditJob } from '@yiji/shared-types';
import {
  EDIT_FROZEN,
  processCouponEditJob,
  recoverStuckCouponEdits,
  yijiMismatch,
} from '../src/processors/coupon-edit.js';
import { yijiCouponPayload, type CouponApprovalRow } from '../src/processors/coupon-push.js';

/**
 * EDIT AN APPROVED COUPON IN PLACE - made safe (owner, 2026-11-12):
 *  - switched OFF on Yiji before "was it used?" and kept off until Yiji shows
 *    exactly the new values (read back), then switched back ON;
 *  - a coupon whose Yiji record differs from the CRM is never overwritten;
 *  - one change at a time (lock + the version the editor opened);
 *  - a retry resumes; a dead edit is put back by the recovery.
 * A fake Yiji that really stores status and values stands in for Yiji.
 */

vi.mock('@directus/sdk', () => ({
  readItem: (collection: string, id: string) => ({ op: 'readItem', collection, id }),
  readItems: (collection: string, query: unknown) => ({ op: 'readItems', collection, query }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    op: 'update',
    collection,
    id,
    payload,
  }),
  createItem: (collection: string, payload: unknown) => ({ op: 'create', collection, payload }),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

/* As Directus returns it: DECIMAL columns as TEXT. */
const ROW = {
  id: 'c1',
  status: 'assigned',
  coupon_code: 'OPS-HNXZRMZC',
  coupon_value: 3,
  coupon_percent: null,
  max_discount: '3.00000',
  usage_limit: 1,
  total_discount_limit: '3.00000',
  valid_from: future(0),
  valid_to: future(7),
  title: '0508315325',
  issuing_side: 'Customer Care',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'La Casa Pasta',
  restaurant_id: '204',
  item_name: null,
  item_sku: null,
  no_other_discounts: false,
  reason: 'Missing item',
  compensation: 'Compensated',
  customer_phone: '0508315325',
  removal_status: null,
  replaced_by: null,
  delivery_excluded: false,
  yiji_coupon_id: '89126',
  yiji_coupon_user_id: '32078',
  yiji_used_order: null,
  edit_state: null,
  edit_request_id: null,
  edit_detail: null,
  contact: { id: 'k1', name: null, phone: '0508315325', external_customer_id: null },
  ticket: { id: 't1', order_id: '183346' },
};
const NEW_TERMS = { ...ROW, coupon_value: 5, max_discount: 5, total_discount_limit: 5 };

function setup(
  opts: {
    row?: Record<string, unknown>;
    /** Yiji's record differs from the CRM's before the edit. */
    yijiOverride?: Record<string, unknown>;
    /** usedOnOrder answers, in order of the calls. */
    used?: Array<string | null>;
    /** Yiji accepts UpdateCoupon but stores these values instead. */
    yijiIgnores?: Record<string, unknown>;
    updateThrows?: Error;
    lockBusy?: boolean;
    switchFailsOnce?: boolean;
    offRefused?: boolean;
    /** couponIdOfGrant answer (default: 89126). */
    walletCouponId?: string | null;
  } = {},
) {
  const row: Record<string, unknown> = { ...ROW, ...(opts.row ?? {}) };
  const events: unknown[] = [];
  const ticketPatches: unknown[] = [];
  const directus = {
    request: vi.fn(async (a: Record<string, unknown>) => {
      if (a.op === 'readItem') return { ...row };
      if (a.op === 'readItems') return row.edit_state === EDIT_FROZEN ? [{ ...row }] : [];
      if (a.op === 'create') return void events.push(a.payload);
      if (a.op === 'update') {
        if (a.collection === 'coupon_approvals') Object.assign(row, a.payload);
        else ticketPatches.push(a.payload);
        return {};
      }
      return null;
    }),
  };
  const yiji: Record<string, unknown> = {
    ...yijiCouponPayload(ROW as unknown as CouponApprovalRow, null, { unassigned: true }),
    id: 89126,
    status: 0,
    assignee: [{ id: 'u1' }],
    ...(opts.yijiOverride ?? {}),
  };
  const used = [...(opts.used ?? [])];
  const calls: string[] = [];
  let switchFailed = false;
  const remover = {
    findCustomer: vi.fn(async () => 'user-1'),
    wallet: vi.fn(),
    removeGrant: vi.fn(),
    usedOnOrder: vi.fn(async () => {
      calls.push('used?');
      return used.length ? used.shift()! : null;
    }),
    couponIdOfGrant: vi.fn(async () =>
      opts.walletCouponId === undefined ? '89126' : opts.walletCouponId,
    ),
    readCoupon: vi.fn(async () => ({ ...yiji })),
    updateCoupon: vi.fn(async (b: Record<string, unknown>) => {
      calls.push(`update(status ${String(b.status)})`);
      if (opts.updateThrows) throw opts.updateThrows;
      Object.assign(yiji, b, opts.yijiIgnores ?? {});
    }),
    setCouponStatus: vi.fn(async (_id: string, s: number) => {
      if (opts.offRefused && s === 5) {
        throw Object.assign(new Error('UpdateStatusCoupon refused (401)'), {
          name: 'YijiRefusedError',
        });
      }
      if (opts.switchFailsOnce && !switchFailed && s === 0) {
        switchFailed = true;
        throw new Error('timed out');
      }
      calls.push(s === 5 ? 'OFF' : 'ON');
      yiji.status = s;
    }),
  };
  const lock = {
    acquire: vi.fn(async () => !opts.lockBusy),
    release: vi.fn(async () => undefined),
  };
  const run = (
    terms: Record<string, unknown> = NEW_TERMS,
    extra: { basedOn?: string; attemptsMade?: number; attempts?: number } = {},
  ) =>
    processCouponEditJob(
      {
        data: {
          couponApprovalId: 'c1',
          editRequestId: 'req-12345678',
          terms,
          editedBy: 'sup-1',
          reason: 'Customer called back',
          basedOn: extra.basedOn ?? couponTermsVersion(ROW as never),
        },
        attemptsMade: extra.attemptsMade ?? 0,
        opts: { attempts: extra.attempts ?? 5 },
      } as unknown as Job<CouponEditJob>,
      { directus: directus as never, logger, remover: remover as never, lock },
    );
  return { run, row, yiji, remover, calls, events, ticketPatches, lock, directus };
}

describe('edit in place: the record on Yiji really changes', () => {
  it('switches OFF, checks unused, updates while off, reads back, saves, switches ON', async () => {
    const t = setup();
    expect(await t.run()).toBe('edited');
    expect(t.calls).toEqual(['OFF', 'used?', 'update(status 5)', 'used?', 'ON']);
    // Yiji now holds the new values, on the SAME coupon, switched back on.
    expect(t.yiji).toMatchObject({
      id: 89126,
      code: 'OPS-HNXZRMZC',
      discount: 5,
      maximumDiscount: 5,
      reachLimit: 5,
      status: 0,
    });
    expect(t.yiji.assignee).toEqual([{ id: 'u1' }]); // holders untouched
    expect(t.row).toMatchObject({
      coupon_value: 5,
      max_discount: 5,
      total_discount_limit: 5,
      edit_state: 'done',
      edited_by: 'sup-1',
      replace_reason: 'Customer called back',
    });
    expect(t.row.coupon_code).toBe('OPS-HNXZRMZC');
    expect(JSON.stringify(t.events[0])).toMatch(
      /edited \(same coupon, updated in the customer’s Yiji app\)/,
    );
    expect(t.remover.removeGrant).not.toHaveBeenCalled();
    expect(t.lock.release).toHaveBeenCalled();
  });

  it('Yiji says OK but stores other values: put back as it was, switched on, CRM unchanged', async () => {
    const t = setup({ yijiIgnores: { discount: 3, maximumDiscount: 3 } });
    expect(await t.run()).toBe('refused');
    expect(t.row.edit_detail).toMatch(
      /Yiji did not take the new values \(discount, maximumDiscount\)/,
    );
    expect(t.row.coupon_value).toBe(3);
    expect(t.yiji.status).toBe(0);
  });

  it('Yiji refuses the update: put back, switched on, refused with the reason', async () => {
    const t = setup({
      updateThrows: Object.assign(new Error('UpdateCoupon refused (403)'), {
        name: 'YijiRefusedError',
      }),
    });
    expect(await t.run()).toBe('refused');
    expect(String(t.row.edit_detail)).toMatch(/did not accept the new values/);
    expect(t.yiji.status).toBe(0);
    expect(t.row.coupon_value).toBe(3);
  });
});

describe('a used coupon never changes', () => {
  it('used before the edit: switched back on untouched, refused, the order recorded', async () => {
    const t = setup({ used: ['1374000'] });
    expect(await t.run()).toBe('refused');
    expect(t.calls).toEqual(['OFF', 'used?', 'ON']);
    expect(t.yiji.discount).toBe(3);
    expect(t.row).toMatchObject({ edit_state: 'refused', yiji_used_order: '1374000' });
  });

  it('used as it was switched off: the new values are taken back off Yiji', async () => {
    const t = setup({ used: [null, '1374001'] });
    expect(await t.run()).toBe('refused');
    expect(t.yiji).toMatchObject({ discount: 3, maximumDiscount: 3, status: 0 });
    expect(t.row).toMatchObject({ coupon_value: 3, yiji_used_order: '1374001' });
  });

  it('already stamped as used: refused without touching Yiji', async () => {
    const t = setup({ row: { yiji_used_order: '1374000' } });
    expect(await t.run()).toBe('refused');
    expect(t.calls).toEqual([]);
  });
});

describe('Yiji and the CRM never disagree', () => {
  it('Yiji changed outside the CRM: refused, nothing overwritten, never switched off', async () => {
    const t = setup({ yijiOverride: { discount: 2, maximumDiscount: 2 } });
    expect(await t.run()).toBe('refused');
    expect(t.row.edit_detail).toMatch(/changed on Yiji outside the CRM/);
    expect(t.calls).toEqual([]);
    expect(t.yiji.discount).toBe(2);
  });

  it('switched off by ops on Yiji (status 5): refused, left as ops left it', async () => {
    const t = setup({ yijiOverride: { status: 5 } });
    expect(await t.run()).toBe('refused');
    expect(t.row.edit_detail).toMatch(/switched off on Yiji/);
    expect(t.yiji.status).toBe(5);
  });

  it('deleted on Yiji (status 1): refused', async () => {
    const t = setup({ yijiOverride: { status: 1 } });
    expect(await t.run()).toBe('refused');
    expect(t.row.edit_detail).toMatch(/deleted on Yiji/);
  });
});

describe('one change at a time', () => {
  it('changed by someone else since the editor opened it: refused', async () => {
    const t = setup({
      row: { coupon_value: 4, max_discount: '4.00000', total_discount_limit: '4.00000' },
    });
    expect(await t.run()).toBe('refused');
    expect(t.row.edit_detail).toMatch(/changed by someone else/);
    expect(t.calls).toEqual([]);
  });

  it('another change holds the lock: retried, and refused only on the last try', async () => {
    const t = setup({ lockBusy: true });
    await expect(t.run(NEW_TERMS, { attemptsMade: 0 })).rejects.toThrow(/another change/);
    expect(await t.run(NEW_TERMS, { attemptsMade: 4 })).toBe('refused');
    expect(t.calls).toEqual([]);
  });

  it('an unchanged save is refused as "the same as before" (text vs number does not count)', async () => {
    const t = setup();
    expect(await t.run({ ...ROW })).toBe('refused');
    expect(t.row.edit_detail).toMatch(/the same as before/);
  });
});

describe('the admin token', () => {
  it('refused (expired): the edit stops before anything on Yiji changes, and says so', async () => {
    const t = setup({ offRefused: true });
    expect(await t.run()).toBe('refused');
    expect(t.row.edit_detail).toMatch(/admin token \(it may have expired\)/);
    expect(t.yiji).toMatchObject({ status: 0, discount: 3 });
    expect(t.row.coupon_value).toBe(3);
  });
});

describe('nothing is left half-done', () => {
  it('switching back on fails once: the retry RESUMES and finishes, same values', async () => {
    const t = setup({ switchFailsOnce: true });
    await expect(t.run()).rejects.toThrow(/timed out/);
    expect(t.row.edit_state).toBe(EDIT_FROZEN);
    expect(t.yiji.status).toBe(5); // still off: nobody can use it half-edited
    expect(await t.run(NEW_TERMS, { attemptsMade: 1 })).toBe('edited');
    expect(t.yiji).toMatchObject({ discount: 5, status: 0 });
    expect(t.row).toMatchObject({ edit_state: 'done', coupon_value: 5 });
  });

  it('an edit that died after switching off is put back and switched on by the recovery', async () => {
    const t = setup();
    t.row.edit_state = EDIT_FROZEN;
    t.row.edit_request_id = 'req-dead';
    t.row.edit_detail = 'Editing: coupon_value: 3 → 5';
    t.row.edited_at = new Date(Date.now() - 60 * 60_000).toISOString();
    Object.assign(t.yiji, { status: 5, discount: 5, maximumDiscount: 5, reachLimit: 5 });
    const r = await recoverStuckCouponEdits({
      directus: t.directus as never,
      logger,
      remover: t.remover as never,
    });
    expect(r).toEqual({ recovered: 1, failed: 0 });
    expect(t.yiji).toMatchObject({ status: 0, discount: 3, maximumDiscount: 3, reachLimit: 3 });
    expect(t.row.edit_state).toBe('refused');
  });
});

describe('coupons from before the total-limit rule (no limit stored, Yiji pool 10000)', () => {
  it('is edited (not mistaken for a change on Yiji); the limit is recorded and sent', async () => {
    const t = setup({ row: { total_discount_limit: null }, yijiOverride: { reachLimit: 10000 } });
    expect(
      await t.run(NEW_TERMS, {
        basedOn: couponTermsVersion({ ...ROW, total_discount_limit: null } as never),
      }),
    ).toBe('edited');
    expect(t.yiji).toMatchObject({ discount: 5, reachLimit: 5, status: 0 });
    expect(t.row).toMatchObject({ coupon_value: 5, total_discount_limit: 5 });
  });

  it('expired on Yiji (status 6): refused with a clear message', async () => {
    const t = setup({ yijiOverride: { status: 6 } });
    expect(await t.run()).toBe('refused');
    expect(t.row.edit_detail).toMatch(/expired on Yiji/);
  });
});

describe('review 2026-11-12: an interrupted edit is never orphaned', () => {
  const frozenBy = (rid: string) => ({
    edit_state: EDIT_FROZEN,
    edit_request_id: rid,
    edit_detail: 'Editing: x',
  });

  it('a second edit does not wipe the frozen mark of the first edit', async () => {
    const t = setup({ row: frozenBy('req-other') });
    expect(await t.run()).toBe('refused');
    expect(t.row).toMatchObject({ edit_state: EDIT_FROZEN, edit_request_id: 'req-other' });
    expect(t.calls).toEqual([]);
  });

  it('busy on the last try leaves a frozen mark for the recovery', async () => {
    const t = setup({ lockBusy: true, row: frozenBy('req-12345678') });
    expect(await t.run(NEW_TERMS, { attemptsMade: 4 })).toBe('refused');
    expect(t.row).toMatchObject({ edit_state: EDIT_FROZEN, edit_request_id: 'req-12345678' });
  });

  it('removed while the edit was interrupted: Yiji put back and on, no new terms written', async () => {
    const t = setup({
      row: { ...frozenBy('req-12345678'), removal_status: 'removed' },
      yijiOverride: { status: 5 },
    });
    expect(await t.run()).toBe('refused');
    expect(t.row.edit_detail).toMatch(/removed or replaced while the edit was interrupted/);
    expect(t.row.coupon_value).toBe(3);
    expect(t.yiji).toMatchObject({ status: 0, discount: 3 });
  });

  it('deleted on Yiji during the edit: left deleted, never switched back on', async () => {
    const t = setup({ row: frozenBy('req-12345678'), yijiOverride: { status: 1 } });
    expect(await t.run()).toBe('refused');
    expect(t.yiji.status).toBe(1);
    expect(t.calls).toEqual([]);
  });

  it('the recovery leaves an expired coupon (status 6) as Yiji has it', async () => {
    const t = setup({
      row: { ...frozenBy('req-dead'), edited_at: new Date(Date.now() - 3_600_000).toISOString() },
      yijiOverride: { status: 6 },
    });
    await recoverStuckCouponEdits({
      directus: t.directus as never,
      logger,
      remover: t.remover as never,
    });
    expect(t.yiji.status).toBe(6);
    expect(t.calls).toEqual([]);
  });
});

describe('older coupons: a grant but no stored coupon id (486 on prod)', () => {
  const grantOnly = { yiji_coupon_id: null, yiji_coupon_user_id: '32078', status: 'assigned' };

  it('is edited ON YIJI: the coupon id comes from the wallet, is stored, full switch-off path', async () => {
    const t = setup({ row: grantOnly });
    expect(await t.run()).toBe('edited');
    expect(t.remover.couponIdOfGrant).toHaveBeenCalledWith('user-1', '32078');
    expect(t.calls).toEqual(['used?', 'OFF', 'used?', 'update(status 5)', 'used?', 'ON']);
    expect(t.yiji).toMatchObject({ discount: 5, status: 0 });
    expect(t.row).toMatchObject({ yiji_coupon_id: '89126', coupon_value: 5, edit_state: 'done' });
  });

  it('already USED: refused before anything on Yiji changes, the order recorded', async () => {
    const t = setup({ row: grantOnly, used: ['1371234'] });
    expect(await t.run()).toBe('refused');
    expect(t.row).toMatchObject({ yiji_used_order: '1371234', coupon_value: 3 });
    expect(t.calls).toEqual(['used?']);
    expect(t.remover.updateCoupon).not.toHaveBeenCalled();
  });

  it('no longer in the wallet (removed on Yiji): refused, nothing changed', async () => {
    const t = setup({ row: grantOnly, walletCouponId: null });
    expect(await t.run()).toBe('refused');
    expect(String(t.row.edit_detail)).toMatch(/no longer in the customer’s Yiji wallet/);
    expect(t.row.coupon_value).toBe(3);
  });

  it('never takes the row-only path just because the coupon id is missing', async () => {
    const t = setup({ row: { ...grantOnly, yiji_coupon_user_id: null } });
    expect(await t.run()).toBe('refused');
    expect(String(t.row.edit_detail)).toMatch(/no Yiji record/);
    expect(t.row.coupon_value).toBe(3);
  });
});

describe('not on Yiji yet', () => {
  it('only the row changes - the push sends the new values', async () => {
    const t = setup({
      row: { status: 'approved', yiji_coupon_id: null, yiji_coupon_user_id: null },
    });
    expect(await t.run({ ...NEW_TERMS, yiji_coupon_id: null })).toBe('edited');
    expect(t.calls).toEqual([]);
    expect(t.row).toMatchObject({ coupon_value: 5, edit_state: 'done' });
  });
});

describe('yijiMismatch', () => {
  it('compares numbers as numbers and dates by day', () => {
    expect(
      yijiMismatch(
        { discount: '5.0', expirationDate: '2026-12-11T23:59:00', dontApplyOffer: false },
        { discount: 5, expirationDate: '2026-12-11T00:00:00', dontApplyOffer: false },
      ),
    ).toEqual([]);
    expect(yijiMismatch({ discount: 3 }, { discount: 5 })).toEqual(['discount']);
    expect(yijiMismatch(null, { discount: 5 })).toEqual(['the coupon']);
  });
});
