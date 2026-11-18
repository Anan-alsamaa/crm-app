import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MockYiji2Transport,
  MockYijiClient,
  Yiji2Connector,
  Yiji2RefusedError,
  YIJI2_ITEM_PAID_CATEGORIES,
  YIJI2_ITEM_PAID_FROM_SECOND,
  compensationCasesOf,
  isYiji2ItemPaidCategory,
  mapYiji2Order,
  yiji2AffectedItemsProblem,
  type Yiji2OrderItemWire,
  type Yiji2OrderWire,
} from '../src/index.js';

/**
 * `order_item_id` ON THE V2 ORDER READ (partner-v1.yaml OrderItem, required
 * since 2026-11-18): the order LINE id that `POST /compensation-cases`
 * `affected_items[].order_item_id` takes. The sample item is V2's own, copied
 * verbatim from yiji-platform `docs/reviews/run2-helpers/order-item-id.md`
 * section 7. ZERO NETWORK.
 */

const SAMPLE_ITEM = JSON.parse(
  readFileSync(new URL('./fixtures/yiji2-order-item-sample.json', import.meta.url), 'utf8'),
) as Yiji2OrderItemWire;

const NOW = Date.parse('2026-11-18T10:00:00Z');

const order = (items: Yiji2OrderItemWire[]): Yiji2OrderWire => ({
  order_number: 2611000000001,
  state: 'delivered',
  placed_at: '2026-11-18T09:00:00Z',
  money: { total: { amount_minor: 5800, currency: 'SAR' } },
  items,
});

const v2 = (t: MockYiji2Transport) =>
  new Yiji2Connector(
    { crmId: 'v2', platformVendorId: '2', platform: 'yiji2', status: 'active' },
    { platform: 'yiji2', mock: true },
    { transport: t },
  );

describe('mapping the real V2 sample item', () => {
  it('the line id lands on orderItemId; the catalogue id never does', () => {
    const o = mapYiji2Order(order([SAMPLE_ITEM]))!;
    expect(o.items).toEqual([
      {
        sku: '301',
        name: 'Burger',
        nameAr: 'برجر',
        qty: 2,
        price: 25,
        lineTotal: 50,
        orderItemId: '7001',
        modifiers: ['Cheese'],
        modifierGroups: [{ name: 'Options', options: [{ name: 'Cheese', qty: 1, price: 0 }] }],
      },
    ]);
    expect(o.items[0]!.orderItemId).not.toBe(String(SAMPLE_ITEM.item_id));
  });

  it('two lines of one catalogue item keep two line ids', () => {
    const second = { ...SAMPLE_ITEM, order_item_id: 7002, quantity: 1 };
    const o = mapYiji2Order(order([SAMPLE_ITEM, second]))!;
    expect(o.items.map((i) => [i.sku, i.orderItemId])).toEqual([
      ['301', '7001'],
      ['301', '7002'],
    ]);
  });

  it('a line id sent as a string is the same id', () => {
    const o = mapYiji2Order(order([{ ...SAMPLE_ITEM, order_item_id: ' 7001 ' }]))!;
    expect(o.items[0]!.orderItemId).toBe('7001');
  });

  it('an item without a line id maps as before (no orderItemId): the picker cannot offer it', () => {
    const { order_item_id: _drop, ...old } = SAMPLE_ITEM;
    const i = mapYiji2Order(order([{ ...old, name: 'Burger' }]))!.items[0]!;
    expect(i).not.toHaveProperty('orderItemId');
    expect(i).not.toHaveProperty('nameAr');
    expect(i.name).toBe('Burger');
  });

  it('v1 is unchanged: a Yiji v1 order carries no line id', async () => {
    const orders = await new MockYijiClient().getOrders('1', 'demo-customer-1');
    expect(orders.flatMap((o) => o.items).length).toBeGreaterThan(0);
    for (const o of orders) for (const i of o.items) expect(i).not.toHaveProperty('orderItemId');
  });
});

describe('the mock V2 order read carries order_item_id per line', () => {
  it('every line of every mock order has its own line id', async () => {
    const c = v2(new MockYiji2Transport({ now: () => NOW }));
    const o = await c.getOrder('2611000000001');
    expect(o!.items.map((i) => [i.name, i.orderItemId, i.qty])).toEqual([
      ['Classic burger', '7001', 2],
      ['Fries', '7002', 1],
    ]);
    expect((await c.getOrder('2611000000002'))!.items[0]!.orderItemId).toBe('7101');
    expect((await c.getOrder('2611000000003'))!.items[0]!.orderItemId).toBe('7201');
  });
});

describe('logging with affected items (mock V2, the contract rules)', () => {
  const setup = () => {
    const t = new MockYiji2Transport({ now: () => NOW });
    return { t, api: compensationCasesOf(v2(t))! };
  };
  const body = (over: Record<string, unknown> = {}) => ({
    order_number: '2611000000001',
    category: 'MIS' as const,
    agent_id: 'u-agent',
    ...over,
  });
  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Yiji2RefusedError);
    return err as Yiji2RefusedError;
  };

  it('sends the line id as a JSON number and V2 answers the line', async () => {
    const { t, api } = setup();
    const c = await api.logComplaint(
      body({ affected_items: [{ order_item_id: '7001', quantity: 1 }] }),
      'key-items-1',
    );
    const sent = t.calls.find((x) => x.path === '/compensation-cases')!.body as {
      affected_items: Array<{ order_item_id: unknown }>;
    };
    expect(sent.affected_items).toEqual([{ order_item_id: 7001, quantity: 1 }]);
    expect(c.affected_items).toEqual([
      {
        order_item_id: 7001,
        quantity: 1,
        line_quantity: 2,
        unit_price_minor: 3200,
        line_total_minor: 6400,
      },
    ]);
  });

  it('refuses the catalogue id, a line of another order, a quantity above the line, a line twice', async () => {
    const { api } = setup();
    const items = (affected_items: unknown) => body({ affected_items }) as never;
    for (const [a, msg] of [
      [[{ order_item_id: '301' }], 'case.item.not_on_order'],
      [[{ order_item_id: '7101' }], 'case.item.not_on_order'],
      [[{ order_item_id: '7001', quantity: 3 }], 'case.item.quantity'],
      [[{ order_item_id: '7001' }, { order_item_id: 7001 }], 'case.item.twice'],
    ] as const) {
      const e = await refused(api.logComplaint(items(a), `key-${msg}-${JSON.stringify(a).length}`));
      expect([e.status, e.field, e.message]).toEqual([400, 'affected_items', msg]);
    }
  });

  it('a category paid on items without items is 400; HAIR without items is accepted', async () => {
    const { api } = setup();
    const e = await refused(api.logComplaint(body(), 'key-noitems-1'));
    expect([e.status, e.message]).toEqual([400, 'case.items.required']);
    const hair = await api.logComplaint(body({ category: 'HAIR' }), 'key-hair-1');
    expect(hair.affected_items).toEqual([]);
  });

  it('the body check refuses a non-numeric or zero line id before anything is sent', async () => {
    const { t, api } = setup();
    for (const id of ['abc', '0', 0, -1, '12345678901234567'])
      await expect(
        api.logComplaint(body({ affected_items: [{ order_item_id: id }] }) as never, 'key-bad-01'),
      ).rejects.toThrow();
    expect(t.calls.filter((x) => x.path === '/compensation-cases')).toEqual([]);
  });
});

describe('which categories need items (V2 rules.csv)', () => {
  it('paid on items from the first time: PRD-1, PRD-2, ACC-1, ACC-2, MIS, REM', () => {
    expect([...YIJI2_ITEM_PAID_CATEGORIES]).toEqual([
      'PRD-1',
      'PRD-2',
      'ACC-1',
      'ACC-2',
      'MIS',
      'REM',
    ]);
    expect([...YIJI2_ITEM_PAID_FROM_SECOND]).toEqual(['HAIR', 'FOREIGN']);
    expect(isYiji2ItemPaidCategory('MIS')).toBe(true);
    expect(isYiji2ItemPaidCategory('HAIR')).toBe(false);
    expect(isYiji2ItemPaidCategory('CUT')).toBe(false);
  });

  it('yiji2AffectedItemsProblem: the same rules as V2, against the order read', () => {
    const lines = [
      { orderItemId: '7001', quantity: 2 },
      { orderItemId: '7002', quantity: 1 },
    ];
    expect(yiji2AffectedItemsProblem('MIS', [], lines)).toEqual({ problem: 'items_required' });
    expect(yiji2AffectedItemsProblem('HAIR', undefined, lines)).toBeNull();
    expect(
      yiji2AffectedItemsProblem('MIS', [{ orderItemId: '7001', quantity: 2 }], lines),
    ).toBeNull();
    expect(yiji2AffectedItemsProblem('MIS', [{ orderItemId: '7001' }], lines)).toBeNull();
    expect(yiji2AffectedItemsProblem('MIS', [{ orderItemId: '301' }], lines)).toEqual({
      problem: 'item_not_on_order',
      index: 0,
    });
    expect(
      yiji2AffectedItemsProblem('MIS', [{ orderItemId: '7002' }, { orderItemId: '7002' }], lines),
    ).toEqual({ problem: 'item_twice', index: 1 });
    for (const q of [0, 3, 1.5])
      expect(
        yiji2AffectedItemsProblem('HAIR', [{ orderItemId: '7001', quantity: q }], lines),
      ).toEqual({ problem: 'item_quantity', index: 0 });
    expect(
      yiji2AffectedItemsProblem(
        'MIS',
        Array.from({ length: 51 }, (_, i) => ({ orderItemId: String(i + 1) })),
        lines,
      ),
    ).toEqual({ problem: 'too_many_items' });
  });
});
