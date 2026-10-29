import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce: {} }));
vi.mock('@directus/sdk', async (orig) => ({
  ...(await orig<typeof import('@directus/sdk')>()),
  createItem: (collection: string, item: unknown) => ({ collection, item }),
}));

import { queueLateOrderBranchNotification } from '../src/features/late-orders/api.js';

/**
 * LATE PREPARATION TELLS THE BRANCH (owner, 2026-10-29). On production this is
 * the one reason a branch is notified: a ticket raised from Late orders (only
 * an `operations` cause raises one) is queued for the branch's SaraPOS outlet,
 * with no notification rule needed. The ticket never depends on it.
 */

const ticket = {
  complaint_type: 'Instore preparation late order',
  description: 'Kitchen was 25 minutes late',
  store: 'store-1',
  vendor: 'vendor-1',
  customer_phone: '0500000001',
};

beforeEach(() => {
  request.mockClear();
  request.mockResolvedValue({});
});

describe('queueLateOrderBranchNotification', () => {
  it("queues the branch's notification with the order, the reason and the action taken", async () => {
    request.mockResolvedValue({});
    const res = await queueLateOrderBranchNotification({
      ticketId: 't1',
      ticket,
      orderId: '1339586',
      actionTaken: 'Apologised to the customer',
    });
    expect(res).toBe('queued');
    const [arg] = request.mock.calls[0]! as [{ collection: string; item: Record<string, unknown> }];
    const sent = JSON.stringify(arg);
    expect(sent).toContain('store_notifications');
    expect(sent).toContain('"ticket":"t1"');
    expect(sent).toContain('"store":"store-1"');
    expect(sent).toContain('"order_id":"1339586"');
    expect(sent).toContain('"resolution_notes":"Apologised to the customer"');
    expect(sent).toContain('"status":"queued"');
    expect(sent).toContain('"vendor":"vendor-1"');
    // Never the customer.
    expect(sent).not.toContain('0500000001');
  });

  it('queues nothing for a ticket with no branch', async () => {
    const res = await queueLateOrderBranchNotification({
      ticketId: 't1',
      ticket: { ...ticket, store: null },
      orderId: '1',
      actionTaken: '',
    });
    expect(res).toBe('skipped');
    expect(request).not.toHaveBeenCalled();
  });

  it('never throws: a refused write is reported as failed', async () => {
    request.mockImplementation(async () => {
      throw new Error('403');
    });
    const res = await queueLateOrderBranchNotification({
      ticketId: 't1',
      ticket,
      orderId: '1',
      actionTaken: '',
    });
    expect(res).toBe('failed');
  });
});

describe('the Late orders page', () => {
  const page = readFileSync(
    resolve(__dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
    'utf8',
  );

  it('queues the branch right after the late-order ticket is created, and only then', () => {
    const created = page.indexOf("createItem('tickets' as never, ticket as never)");
    const queued = page.indexOf('queueLateOrderBranchNotification({');
    expect(created).toBeGreaterThan(0);
    expect(queued).toBeGreaterThan(created);
    expect(page.slice(created, queued)).toContain('if (created?.id)');
  });
});
