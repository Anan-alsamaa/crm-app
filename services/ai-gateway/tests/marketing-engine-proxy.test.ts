import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerMarketingEngineProxy } from '../src/marketing/engine.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch double: Directus answers the door, the engine answers by path. */
function setup(opts: {
  door: number;
  engineUrl?: string;
  engineKey?: string;
  engine?: (url: string, init?: RequestInit) => Response;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/items/marketing_activity')) return json(opts.door, { data: [] });
    return opts.engine ? opts.engine(url, init) : json(404, {});
  });
  const app = Fastify();
  void registerMarketingEngineProxy(app, {
    directusUrl: 'https://d.test',
    engineUrl: opts.engineUrl ?? 'https://v2.test/',
    engineKey: opts.engineKey ?? 'engine-key',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const call = (method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      payload: body as never,
      headers: { authorization: 'Bearer user-token' },
    });
  return { app, call, calls };
}

describe('the promotion engine proxy', () => {
  it('refuses anyone the Marketing portal is not open to, before touching the engine', async () => {
    const { call, calls } = setup({ door: 403 });
    const r = await call('GET', '/commerce/marketing/engine/home');
    expect(r.statusCode).toBe(403);
    expect(calls.some((c) => c.url.includes('v2.test'))).toBe(false);
  });

  it('answers 503 engine_not_configured until the engine variables are set', async () => {
    const { call, calls } = setup({ door: 200, engineUrl: '', engineKey: '' });
    const r = await call('GET', '/commerce/marketing/engine/home');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'engine_not_configured' });
    expect(calls.filter((c) => !c.url.includes('d.test'))).toHaveLength(0);
  });

  it('forwards 1:1 under /v1 with the engine key, the query string and the body', async () => {
    const { call, calls } = setup({
      door: 200,
      engine: (url) => (url.includes('/v1/campaigns') ? json(200, [{ id: 'C-1' }]) : json(404, {})),
    });
    const r = await call('GET', '/commerce/marketing/engine/campaigns?status=live');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ data: [{ id: 'C-1' }] });
    const fwd = calls.find((c) => c.url.includes('v2.test'))!;
    expect(fwd.url).toBe('https://v2.test/v1/campaigns?status=live');
    expect((fwd.init?.headers as Record<string, string>).authorization).toBe('Bearer engine-key');

    const p = await call('POST', '/commerce/marketing/engine/campaigns/C-1/decision', {
      decision: 'approve',
      note: 'ok',
    });
    expect(p.statusCode).toBe(200);
    const post = calls.filter((c) => c.url.includes('v2.test')).at(-1)!;
    expect(post.init?.method).toBe('POST');
    expect(post.init?.body).toBe(JSON.stringify({ decision: 'approve', note: 'ok' }));
  });

  it('passes an engine refusal through with its code, and never a 200', async () => {
    const { call } = setup({
      door: 200,
      engine: () => json(403, { error: 'own_campaign', message: 'The creator cannot approve' }),
    });
    const r = await call('POST', '/commerce/marketing/engine/campaigns/C-1/decision', {
      decision: 'approve',
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'own_campaign', detail: 'The creator cannot approve' });
  });

  it('rejects a path that could escape the engine prefix', async () => {
    const { call } = setup({ door: 200 });
    const r = await call('GET', '/commerce/marketing/engine/..%2Fadmin');
    expect([400, 404]).toContain(r.statusCode);
  });
});
