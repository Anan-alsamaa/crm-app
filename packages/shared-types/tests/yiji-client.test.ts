import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createYijiClient, HttpYijiClient, MockYijiClient, type YijiOrder } from '../src/index.js';

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
    const c = await mock.getCustomer('demo-vendor', 'demo-customer-1');
    expect(c).not.toBeNull();
    expect(c?.name).toBe('Demo Customer');
    expect(c?.phone).toBe('+966500000001');
  });

  it('returns null for unknown customer', async () => {
    expect(await mock.getCustomer('demo-vendor', 'no-such')).toBeNull();
    expect(await mock.getCustomer('other-vendor', 'demo-customer-1')).toBeNull();
  });

  it('returns orders ordered newest first by fixture order', async () => {
    const orders = await mock.getOrders('demo-vendor', 'demo-customer-1');
    expect(orders.length).toBeGreaterThan(0);
    expect(orders[0]?.orderId).toBe('O-5921');
  });

  it('respects the limit option on getOrders', async () => {
    const all = await mock.getOrders('demo-vendor', 'demo-customer-1');
    const limited = await mock.getOrders('demo-vendor', 'demo-customer-1', { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]).toEqual(all[0]);
  });

  it('returns payment status for a known order', async () => {
    const p = await mock.getPaymentStatus('demo-vendor', 'O-5921');
    expect(p?.status).toBe('captured');
    expect(p?.method).toBe('mada');
  });

  it('returns shipment tracking with at least one event', async () => {
    const s = await mock.getShipmentTracking('demo-vendor', 'O-5921');
    expect(s?.carrier).toBe('SMSA');
    expect(s?.events.length).toBeGreaterThanOrEqual(2);
  });

  it('returns purchase activity with lifetime value', async () => {
    const a = await mock.getPurchaseActivity('demo-vendor', 'demo-customer-1');
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

  it('calls the expected URL for getCustomer', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ externalCustomerId: 'c1', name: 'Test' }), { status: 200 }),
    );
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    const c = await client.getCustomer('v1', 'c1');
    expect(c?.name).toBe('Test');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/vendors/v1/customers/c1',
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

  it('returns null on 500 instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    expect(await client.getCustomer('v1', 'c1')).toBeNull();
  });

  it('returns null on network error instead of throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    expect(await client.getCustomer('v1', 'c1')).toBeNull();
  });

  it('getOrders returns [] when upstream returns null', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    const result = await client.getOrders('v1', 'c1');
    expect(result).toEqual([]);
  });

  it('forwards limit as a query string', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    await client.getOrders('v1', 'c1', { limit: 5 });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('?limit=5');
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
    const result = await client.getCustomer('v1', 'c1');
    expect(result).toBeNull();
  });

  it('returns array shape for orders directly', async () => {
    const fakeOrders: YijiOrder[] = [
      {
        orderId: 'O1',
        status: 'placed',
        total: 10,
        currency: 'USD',
        placedAt: '2026-01-01T00:00:00Z',
        items: [],
      },
    ];
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fakeOrders), { status: 200 }));
    const client = new HttpYijiClient({ baseUrl: 'https://api.example.com' });
    const result = await client.getOrders('v1', 'c1');
    expect(result).toHaveLength(1);
    expect(result[0]?.orderId).toBe('O1');
  });
});
