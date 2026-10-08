import { describe, expect, it } from 'vitest';
import { CrmClient, itemsQuery } from '../src/client.js';
import type { FetchLike } from '../src/guard.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('CrmClient', () => {
  it('logs in, re-authenticates once on 401, and only ever sends GET or the auth POSTs', async () => {
    const sent: string[] = [];
    let n = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      sent.push(`${init.method} ${url.pathname}`);
      if (url.pathname === '/auth/login')
        return json(200, { data: { access_token: `a${++n}`, refresh_token: 'r' } });
      if (url.pathname === '/auth/refresh')
        return json(200, { data: { access_token: `a${++n}`, refresh_token: 'r2' } });
      const auth = (init.headers as Record<string, string>).authorization;
      return auth === 'Bearer a1'
        ? json(401, { errors: [{ message: 'expired' }] })
        : json(200, { data: [{ id: 1 }] });
    };
    const c = new CrmClient(() => ({ email: 'e', password: 'p' }), fetchImpl);
    await expect(c.items('vendors', { limit: 1 })).resolves.toEqual([{ id: 1 }]);
    expect(sent).toEqual([
      'POST /auth/login',
      'GET /items/vendors',
      'POST /auth/refresh',
      'GET /items/vendors',
    ]);
  });

  it('errors never contain the token', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.pathname === '/auth/login'
        ? json(200, { data: { access_token: 'SECRET-TOKEN', refresh_token: 'r' } })
        : json(403, { errors: [{ message: 'Forbidden' }] });
    const c = new CrmClient(() => ({ email: 'e', password: 'p' }), fetchImpl);
    const err = await c.items('x', {}).catch((e: Error) => e);
    expect(String(err)).toContain('403');
    expect(String(err)).not.toContain('SECRET-TOKEN');
  });

  it('encodes Directus aggregate / groupBy queries', () => {
    expect(
      itemsQuery({
        aggregate: { count: 'id' },
        groupBy: ['assigned_agent'],
        filter: { a: 1 },
        limit: -1,
      }),
    ).toEqual({
      'aggregate[count]': 'id',
      'groupBy[0]': 'assigned_agent',
      filter: '{"a":1}',
      limit: -1,
    });
  });
});
