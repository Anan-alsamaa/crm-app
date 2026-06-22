import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// aiAdmin now authenticates with the admin's Directus SESSION token (C-1) — no
// static browser service token, no self-asserted x-yiji-admin header.
vi.mock('../src/lib/directus.js', () => ({
  auth: { getToken: vi.fn(async () => 'admin-access-token') },
}));

import { aiAdmin } from '../src/lib/ai-client.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('aiAdmin client', () => {
  it('getConfig issues a GET with the session Bearer (no self-asserted admin header)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ summarize: true }));
    const res = await aiAdmin.getConfig({ userId: 'admin-1' });
    expect(res).toEqual({ summarize: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/admin/config');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer admin-access-token');
    expect(headers['x-yiji-vendor']).toBe('global');
    // C-1: admin status is derived from the verified Directus role, not a header.
    expect(headers).not.toHaveProperty('x-yiji-admin');
    expect(headers).not.toHaveProperty('x-yiji-user');
  });

  it('putConfig sends a PUT with a JSON body', async () => {
    fetchMock.mockResolvedValueOnce(ok({ summarize: false }));
    const res = await aiAdmin.putConfig({ userId: 'admin-1' }, { summarize: false });
    expect(res).toEqual({ summarize: false });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('PUT');
    expect((init as RequestInit).body).toBe(JSON.stringify({ summarize: false }));
  });

  it('getUsage returns parsed usage', async () => {
    fetchMock.mockResolvedValueOnce(ok({ used: 5, cap: 100 }));
    const res = await aiAdmin.getUsage({ userId: 'admin-1' });
    expect(res).toEqual({ used: 5, cap: 100 });
  });

  it('throws with status on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' }),
    });
    await expect(aiAdmin.getConfig({ userId: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('uses the provided vendorId when given', async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    await aiAdmin.getConfig({ userId: 'x', vendorId: 'v-9' });
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-yiji-vendor']).toBe('v-9');
  });
});
