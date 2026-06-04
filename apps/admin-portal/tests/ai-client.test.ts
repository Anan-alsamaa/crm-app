import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  it('getConfig issues a GET with caller headers', async () => {
    fetchMock.mockResolvedValueOnce(ok({ summarize: true }));
    const res = await aiAdmin.getConfig({ userId: 'admin-1' });
    expect(res).toEqual({ summarize: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/admin/config');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-yiji-user']).toBe('admin-1');
    expect(headers['x-yiji-admin']).toBe('1');
    expect(headers['x-yiji-vendor']).toBe('global');
  });

  it('putConfig sends a PUT with a JSON body', async () => {
    fetchMock.mockResolvedValueOnce(ok({ summarize: false }));
    const res = await aiAdmin.putConfig({ userId: 'admin-1' }, { summarize: false });
    expect(res).toEqual({ summarize: false });
    const [, init] = fetchMock.mock.calls[0];
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
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-yiji-vendor']).toBe('v-9');
  });
});
