import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { CouponEditJob } from '@yiji/shared-types';
import { processCouponEditJob } from '../src/processors/coupon-edit.js';

/**
 * EDIT AN APPROVED COUPON IN PLACE (owner, 2026-11-11): the SAME coupon (same
 * code) takes the new terms on Yiji and on its row - never removed and
 * re-issued (Yiji's monthly report would count two). A used coupon never
 * changes. Measured on the owner's test coupon OPS-HNXZRMZC: UpdateCoupon with
 * the admin token changed 1 -> 2 SAR, same code, same grant.
 */

vi.mock('@directus/sdk', () => ({
  readItem: (collection: string, id: string, opts: unknown) => ({ collection, id, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({ collection, id, payload }),
  createItem: (collection: string, payload: unknown) => ({ collection, payload, create: true }),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

const ROW = {
  id: 'c1',
  status: 'assigned',
  coupon_code: 'OPS-HNXZRMZC',
  coupon_value: 1,
  coupon_percent: null,
  max_discount: 1,
  usage_limit: 1,
  total_discount_limit: 1,
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
  contact: { id: 'k1', name: null, phone: '0508315325', external_customer_id: null },
  ticket: { id: 't1', order_id: '183346' },
};
const YIJI = {
  id: 89126,
  code: 'OPS-HNXZRMZC',
  name: '+966508315325',
  type: 1,
  category: 1,
  discount: 1,
  discountPercentage: 0,
  maximumDiscount: 1,
  reachLimit: 1,
  limitForUser: 1,
  status: 0,
  assignee: [{ id: 'u1' }],
  expirationDate: `${future(7)}T23:59:00`,
};
const TERMS = { ...ROW, coupon_value: 2, max_discount: 2, total_discount_limit: 2 };

function setup(
  opts: {
    row?: Record<string, unknown>;
    usedOn?: string | null;
    afterYiji?: Record<string, unknown> | null;
    updateThrows?: Error;
  } = {},
) {
  const row = { ...ROW, ...(opts.row ?? {}) };
  const patches: Array<{ collection: string; payload: Record<string, unknown> }> = [];
  const created: unknown[] = [];
  const directus = {
    request: vi.fn(async (a: Record<string, unknown>) => {
      if ('create' in a) {
        created.push(a.payload);
        return {};
      }
      if ('payload' in a) {
        patches.push({
          collection: a.collection as string,
          payload: a.payload as Record<string, unknown>,
        });
        return {};
      }
      return row;
    }),
  };
  let reads = 0;
  const sent: Array<Record<string, unknown>> = [];
  const remover = {
    findCustomer: vi.fn(async () => 'user-1'),
    wallet: vi.fn(),
    usedOnOrder: vi.fn(async () => opts.usedOn ?? null),
    removeGrant: vi.fn(),
    readCoupon: vi.fn(async () => {
      reads += 1;
      if (reads === 1) return { ...YIJI };
      return opts.afterYiji === undefined ? { ...YIJI, ...sent.at(-1) } : opts.afterYiji;
    }),
    updateCoupon: vi.fn(async (b: Record<string, unknown>) => {
      if (opts.updateThrows) throw opts.updateThrows;
      sent.push(b);
    }),
  };
  const run = (terms: Record<string, unknown> = TERMS) =>
    processCouponEditJob(
      {
        data: {
          couponApprovalId: 'c1',
          editRequestId: 'req-12345678',
          terms,
          editedBy: 'sup-1',
          reason: 'Customer called back',
        },
        attemptsMade: 0,
        opts: { attempts: 1 },
      } as unknown as Job<CouponEditJob>,
      { directus: directus as never, logger, remover: remover as never },
    );
  const rowPatch = () =>
    patches.filter((p) => p.collection === 'coupon_approvals').at(-1)?.payload ?? {};
  return { run, remover, sent, patches, created, rowPatch };
}

describe('editing an approved coupon in place', () => {
  it('updates the SAME coupon on Yiji (same id and code, new values) and the same CRM row', async () => {
    const t = setup();
    expect(await t.run()).toBe('edited');
    expect(t.remover.removeGrant).not.toHaveBeenCalled();
    const body = t.sent[0]!;
    expect(body).toMatchObject({
      id: 89126,
      code: 'OPS-HNXZRMZC',
      name: '+966508315325',
      discount: 2,
      maximumDiscount: 2,
      reachLimit: 2,
    });
    expect(body.assignee).toEqual([{ id: 'u1' }]); // the holders are never touched
    expect(t.rowPatch()).toMatchObject({
      coupon_value: 2,
      max_discount: 2,
      total_discount_limit: 2,
      edit_state: 'done',
      edit_request_id: 'req-12345678',
      edited_by: 'sup-1',
      replace_reason: 'Customer called back',
    });
    expect(t.rowPatch()).not.toHaveProperty('coupon_code');
  });

  it('tells the ticket: new value and a history line naming the change and the reason', async () => {
    const t = setup();
    await t.run();
    expect(t.patches.some((p) => p.collection === 'tickets')).toBe(true);
    expect(JSON.stringify(t.created[0])).toMatch(/OPS-HNXZRMZC edited \(same coupon/);
    expect(JSON.stringify(t.created[0])).toMatch(/Customer called back/);
  });

  it('a coupon the customer already USED never changes - refused, Yiji untouched, the use recorded', async () => {
    const t = setup({ usedOn: '1374000' });
    expect(await t.run()).toBe('refused');
    expect(t.remover.updateCoupon).not.toHaveBeenCalled();
    expect(t.rowPatch()).toMatchObject({ edit_state: 'refused', yiji_used_order: '1374000' });
    expect(t.rowPatch()).not.toHaveProperty('coupon_value');
  });

  it('a coupon already stamped as used is refused without asking Yiji', async () => {
    const t = setup({ row: { yiji_used_order: '1374000' } });
    expect(await t.run()).toBe('refused');
    expect(t.remover.usedOnOrder).not.toHaveBeenCalled();
    expect(t.remover.updateCoupon).not.toHaveBeenCalled();
  });

  it('not on Yiji yet: only the row changes (the push sends the new values)', async () => {
    const t = setup({
      row: { status: 'approved', yiji_coupon_id: null, yiji_coupon_user_id: null },
    });
    expect(await t.run()).toBe('edited');
    expect(t.remover.readCoupon).not.toHaveBeenCalled();
    expect(t.rowPatch()).toMatchObject({ coupon_value: 2, edit_state: 'done' });
  });

  it('Yiji says OK but shows other values: refused, the CRM row keeps its terms', async () => {
    const t = setup({ afterYiji: { ...YIJI } });
    expect(await t.run()).toBe('refused');
    expect(t.rowPatch()).toMatchObject({ edit_state: 'refused' });
    expect(t.rowPatch()).not.toHaveProperty('coupon_value');
  });

  it('Yiji refuses the update: refused with the reason, nothing changed', async () => {
    const t = setup({
      updateThrows: Object.assign(new Error('UpdateCoupon refused (403)'), {
        name: 'YijiRefusedError',
      }),
    });
    expect(await t.run()).toBe('refused');
    expect(String(t.rowPatch().edit_detail)).toMatch(/did not accept/);
  });

  it('terms that could never be approved are refused before Yiji is asked', async () => {
    const t = setup();
    expect(await t.run({ ...TERMS, title: '' })).toBe('refused');
    expect(t.remover.readCoupon).not.toHaveBeenCalled();
  });

  it('a removed or replaced coupon cannot be edited', async () => {
    for (const row of [{ removal_status: 'removed' }, { replaced_by: 'c2' }]) {
      const t = setup({ row });
      expect(await t.run()).toBe('refused');
      expect(t.remover.updateCoupon).not.toHaveBeenCalled();
    }
  });
});
