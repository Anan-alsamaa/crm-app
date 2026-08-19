import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createYijiClient,
  HttpYijiClient,
  isYijiUnavailable,
  MockYijiClient,
} from '../src/index.js';

describe('createYijiClient factory', () => {
  it('returns MockYijiClient when no apiUrl is set', () => {
    expect(createYijiClient()).toBeInstanceOf(MockYijiClient);
    expect(createYijiClient({})).toBeInstanceOf(MockYijiClient);
    expect(createYijiClient({ apiUrl: '' })).toBeInstanceOf(MockYijiClient);
    expect(createYijiClient({ apiUrl: '   ' })).toBeInstanceOf(MockYijiClient);
  });

  it('returns HttpYijiClient when apiUrl is set', () => {
    expect(createYijiClient({ apiUrl: 'https://api.example.com' })).toBeInstanceOf(HttpYijiClient);
  });

  it('HttpYijiClient throws if apiUrl is empty at construction', () => {
    expect(() => new HttpYijiClient({ baseUrl: '' })).toThrow(/baseUrl/);
  });
});

describe('MockYijiClient', () => {
  const mock = new MockYijiClient();

  it('returns the seeded demo customer', async () => {
    const c = await mock.getCustomer('1', 'demo-customer-1');
    expect(c).not.toBeNull();
    expect(c?.name).toBe('Demo Customer');
    expect(c?.phone).toBe('+966500000001');
  });

  it('returns null for unknown customer', async () => {
    expect(await mock.getCustomer('1', 'no-such')).toBeNull();
    expect(await mock.getCustomer('other-vendor', 'demo-customer-1')).toBeNull();
  });

  it('returns orders ordered newest first by fixture order', async () => {
    const orders = await mock.getOrders('1', 'demo-customer-1');
    expect(orders.length).toBeGreaterThan(0);
    expect(orders[0]?.orderId).toBe('O-5921');
  });

  it('respects the limit option on getOrders', async () => {
    const all = await mock.getOrders('1', 'demo-customer-1');
    const limited = await mock.getOrders('1', 'demo-customer-1', { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]).toEqual(all[0]);
  });

  it('returns payment status for a known order', async () => {
    const p = await mock.getPaymentStatus('1', 'O-5921');
    expect(p?.status).toBe('captured');
    expect(p?.method).toBe('mada');
  });

  it('returns shipment tracking with at least one event', async () => {
    const s = await mock.getShipmentTracking('1', 'O-5921');
    expect(s?.carrier).toBe('SMSA');
    expect(s?.events.length).toBeGreaterThanOrEqual(2);
  });

  it('returns purchase activity with lifetime value', async () => {
    const a = await mock.getPurchaseActivity('1', 'demo-customer-1');
    expect(a?.lifetimeValue).toBeGreaterThan(0);
    expect(a?.orderCount).toBeGreaterThan(0);
    expect(a?.recent.length).toBeGreaterThan(0);
  });
});

describe('HttpYijiClient', () => {
  const fetchOriginal = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = fetchOriginal;
  });

  it('getCustomer derives the customer from the Yiji user order list', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ id: 1, customerName: 'Test', customerPhoneNumber: '+966500000000' }]),
        { status: 200 },
      ),
    );
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    const c = await client.getCustomer('v1', 'c1');
    expect(c?.name).toBe('Test');
    expect(c?.phone).toBe('+966500000000');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/Order/GetOrderByUser/c1',
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/json' }) }),
    );
  });

  it('sends bearer token when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ externalCustomerId: 'c1' }), { status: 200 }),
    );
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com', token: 't-abc' });
    await client.getCustomer('v1', 'c1');
    const initArg = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((initArg.headers as Record<string, string>).authorization).toBe('Bearer t-abc');
  });

  it('returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    expect(await client.getCustomer('v1', 'gone')).toBeNull();
  });

  /**
   * These three used to assert `null` — "never throw, surface as unavailable
   * via null". That looked defensive and was the opposite: getOrders maps null
   * to [], so a 500, a DNS failure and a timeout all reached the agent as "No
   * orders found for this contact", a positive claim about the customer made
   * from no information, cached for 45 seconds. `null` now means one thing
   * only: the upstream answered, and there is nothing there.
   */
  it('THROWS on 500 rather than reporting the customer has nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    await expect(client.getCustomer('v1', 'c1')).rejects.toSatisfy(isYijiUnavailable);
  });

  it('THROWS on a network error rather than reporting the customer has nothing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    await expect(client.getOrders('v1', 'c1')).rejects.toSatisfy(isYijiUnavailable);
  });

  it('still returns null for a 404 — the one honest "nothing there"', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    expect(await client.getCustomer('v1', 'c1')).toBeNull();
  });

  it('getOrders returns [] when upstream returns null', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    const result = await client.getOrders('v1', 'c1');
    expect(result).toEqual([]);
  });

  it('applies the limit client-side (GetOrderByUser, no query string)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: 3, creationTime: '2026-03-01T00:00:00Z' },
          { id: 2, creationTime: '2026-02-01T00:00:00Z' },
          { id: 1, creationTime: '2026-01-01T00:00:00Z' },
        ]),
        { status: 200 },
      ),
    );
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    const result = await client.getOrders('v1', 'c1', { limit: 2 });
    expect(result).toHaveLength(2);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe('https://api.example.com/api/Order/GetOrderByUser/c1');
  });

  it('aborts after configured timeout', async () => {
    // fetch that never resolves — abort signal is the only way out
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com', timeoutMs: 30 });
    // A timeout is "we could not ask", not "there is nothing".
    await expect(client.getCustomer('v1', 'c1')).rejects.toSatisfy(isYijiUnavailable);
  });

  it('maps the raw Yiji order array (id, status code, items)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 1,
            orderStatus: 9,
            total: 10,
            creationTime: '2026-01-01T00:00:00Z',
            orderItems: [{ idChooseableItem: 9, itemName: 'Pasta', quantity: 1, itemPrice: 10 }],
          },
        ]),
        { status: 200 },
      ),
    );
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    const result = await client.getOrders('v1', 'c1');
    expect(result).toHaveLength(1);
    expect(result[0]?.orderId).toBe('1');
    expect(result[0]?.status).toBe('delivered');
    expect(result[0]?.currency).toBe('SAR');
    expect(result[0]?.items[0]?.name).toBe('Pasta');
  });
});

describe('order status history (admin API)', () => {
  it('maps rows to a chronological timeline with named statuses', async () => {
    const { mapStatusHistory } = await import('../src/yiji-impl.js');
    // The client's real response shape for GetOrderStatusHistoriesByOrderId —
    // only orderStatus + creationTime matter.
    const rows = [
      {
        id: 1,
        orderStatus: 0,
        orderId: 1213775,
        status: 0,
        creationTime: '2026-08-19T05:34:48.805721',
      },
      {
        id: 2,
        orderStatus: 1,
        orderId: 1213775,
        status: 0,
        creationTime: '2026-08-19T05:34:49.069472',
      },
      {
        id: 3,
        orderStatus: 15,
        orderId: 1213775,
        status: 0,
        creationTime: '2026-08-19T05:35:00.499768',
      },
      {
        id: 4,
        orderStatus: 16,
        orderId: 1213775,
        status: 0,
        creationTime: '2026-08-19T05:35:02.798787',
      },
      {
        id: 5,
        orderStatus: 5,
        orderId: 1213775,
        status: 0,
        creationTime: '2026-08-19T05:35:03.110616',
      },
      {
        id: 6,
        orderStatus: 7,
        orderId: 1213775,
        status: 0,
        creationTime: '2026-08-19T05:58:26.74181',
      },
      {
        id: 7,
        orderStatus: 13,
        orderId: 1213775,
        status: 0,
        creationTime: '2026-08-19T05:58:35.25172',
      },
    ];
    const t = mapStatusHistory('1213775', rows);
    expect(t.derived).toBe(false);
    expect(t.events.map((e) => e.status)).toEqual([
      'initial',
      'pending_payment',
      'paid',
      'pos_accepted',
      'in_kitchen',
      'ready_to_pickup',
      'force_closed',
    ]);
    expect(t.current).toBe('force_closed');
    expect(t.events[0]?.at).toBe('2026-08-19T05:34:48.805721');
  });

  it('sorts out-of-order rows and skips rows with no status', async () => {
    const { mapStatusHistory } = await import('../src/yiji-impl.js');
    const t = mapStatusHistory('9', [
      { orderStatus: 9, creationTime: '2026-01-02T00:00:00' },
      { orderStatus: 0, creationTime: '2026-01-01T00:00:00' },
      { creationTime: '2026-01-03T00:00:00' },
      { orderStatus: 999, creationTime: '2026-01-04T00:00:00' },
    ]);
    expect(t.events.map((e) => e.status)).toEqual(['initial', 'delivered', 'status_999']);
    expect(t.current).toBe('status_999');
  });

  it('getOrderTimeline uses the admin history and falls back to derived when it fails', async () => {
    const { HttpYijiClient } = await import('../src/yiji-impl.js');
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/api/Account/login')) {
        return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
      }
      if (u.includes('/api/OrderStatusHistories/')) {
        return new Response(
          JSON.stringify([{ orderStatus: 0, creationTime: '2026-01-01T00:00:00' }]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpYijiClient({
      baseUrl: 'https://api.example.com',
      adminUrl: 'https://admin.example.com',
      adminEmail: 'svc@example.com',
      adminPassword: 'pw',
    });
    const t = await client.getOrderTimeline('v1', '7');
    expect(t?.derived).toBe(false);
    expect(t?.events[0]?.status).toBe('initial');

    // Admin API down → the derived fallback from the single-order endpoint.
    const fallbackFetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('admin.example.com')) return new Response('down', { status: 503 });
      return new Response(
        JSON.stringify({
          id: 7,
          orderStatus: 9,
          paymentStatus: 1,
          creationTime: '2026-01-01T00:00:00',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fallbackFetch);
    const t2 = await client.getOrderTimeline('v1', '7');
    expect(t2?.derived).toBe(true);
    expect(t2?.current).toBe('delivered');
  });
});
