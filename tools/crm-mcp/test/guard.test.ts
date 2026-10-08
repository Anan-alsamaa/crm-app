import { describe, expect, it, vi } from 'vitest';
import { API_ORIGIN, assertReadOnly, readOnlyFetch, ReadOnlyViolation } from '../src/guard.js';

describe('read-only guard', () => {
  it('allows GET on any path of the production API', () => {
    expect(assertReadOnly('GET', '/items/conversations?limit=1').href).toBe(
      `${API_ORIGIN}/items/conversations?limit=1`,
    );
    expect(assertReadOnly('get', '/commerce/order?orderId=1&vendorId=1').pathname).toBe(
      '/commerce/order',
    );
  });

  it('allows exactly the two session POSTs', () => {
    expect(() => assertReadOnly('POST', '/auth/login')).not.toThrow();
    expect(() => assertReadOnly('POST', '/auth/refresh')).not.toThrow();
    expect(() => assertReadOnly('POST', `${API_ORIGIN}/auth/login/`)).not.toThrow();
  });

  it.each([
    ['PATCH', '/items/tickets/abc'],
    ['PUT', '/items/tickets/abc'],
    ['DELETE', '/items/conversations/abc'],
    ['POST', '/items/messages'],
    ['POST', '/auth/logout'],
    ['POST', '/auth/password/reset'],
    ['POST', '/flows/trigger/x'],
    ['PATCH', '/users/me'],
    ['HEAD', '/items/tickets'],
  ])('refuses %s %s', (method, url) => {
    expect(() => assertReadOnly(method, url)).toThrow(ReadOnlyViolation);
  });

  it('refuses any other host, even for GET', () => {
    expect(() => assertReadOnly('GET', 'https://crm-api-staging.anan.sa/items/x')).toThrow(
      ReadOnlyViolation,
    );
    expect(() => assertReadOnly('GET', 'http://crm-api.anan.sa/items/x')).toThrow(
      ReadOnlyViolation,
    );
    expect(() => assertReadOnly('POST', 'https://evil.example/auth/login')).toThrow(
      ReadOnlyViolation,
    );
  });

  it('never reaches the network for a refused request, and sends the checked verb', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    await expect(readOnlyFetch('DELETE', '/items/tickets/1', {}, fetchImpl)).rejects.toThrow(
      ReadOnlyViolation,
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    await readOnlyFetch('get', '/server/ping', {}, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(`${API_ORIGIN}/server/ping`);
    expect(init.method).toBe('GET');
  });
});
