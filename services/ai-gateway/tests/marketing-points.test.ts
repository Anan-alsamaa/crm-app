import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerMarketingPointsRoutes } from '../src/marketing/points.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch double: Directus answers the door, Yiji answers by path. */
function setup(opts: { door: number; yiji?: Record<string, unknown> }) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('/items/marketing_activity')) return json(opts.door, { data: [] });
    if (url.endsWith('/api/Account/login')) return json(200, { token: 't' });
    for (const [part, body] of Object.entries(opts.yiji ?? {}))
      if (url.includes(part)) return json(200, body);
    return json(404, {});
  });
  const app = Fastify();
  void registerMarketingPointsRoutes(app, {
    directusUrl: 'https://d.test',
    yiji: { adminApiUrl: 'https://y.test', email: 'crm@x', password: 'p', tenantId: '1' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: 'Bearer user-token' } });
  return { app, get, calls };
}

describe('marketing points lookups', () => {
  it('refuses anyone the Marketing portal is not open to, before asking Yiji', async () => {
    const { get, calls } = setup({ door: 403 });
    const r = await get('/commerce/marketing/points/rules');
    expect(r.statusCode).toBe(403);
    expect(calls.some((c) => c.includes('y.test'))).toBe(false);
  });

  it('finds a customer only on an exact +966 match and returns their points', async () => {
    const { get } = setup({
      door: 200,
      yiji: {
        GetfilteredCustomers: [
          { id: 'u-1', phoneNumber: '+966501234567', fullName: 'Ali' },
          { id: 'u-2', phoneNumber: '+9715501234567' },
        ],
        'GetUserLoyalityPoints/User/u-1': [{ points: 120 }],
      },
    });
    const r = await get('/commerce/marketing/points/customer?phone=0501234567');
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({
      found: true,
      customer: { id: 'u-1', phone: '0501234567', name: 'Ali' },
      points: [{ points: 120 }],
    });
  });

  it('says so when no single account has the number', async () => {
    const { get } = setup({ door: 200, yiji: { GetfilteredCustomers: [] } });
    const r = await get('/commerce/marketing/points/customer?phone=0501234567');
    expect(r.json().data).toEqual({ found: false, reason: 'none' });
  });

  it('a report may cover at most 31 days', async () => {
    const { get } = setup({ door: 200, yiji: { IssuedPoints: [] } });
    const long = await get(
      '/commerce/marketing/points/report?type=issued&from=2026-09-01&to=2026-11-01',
    );
    expect(long.statusCode).toBe(400);
    const ok = await get(
      '/commerce/marketing/points/report?type=issued&from=2026-10-01%2007:00&to=2026-11-01%2007:00',
    );
    expect(ok.statusCode).toBe(200);
  });
});
