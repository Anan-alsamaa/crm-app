import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  HttpYijiClient,
  YijiConnector,
  type YijiUsageEvent,
  type YijiUsageSink,
} from '../src/index.js';

const createYijiConnectorForTest = (vendorId: string, onUsage: YijiUsageSink) =>
  new YijiConnector(
    { platformVendorId: vendorId, platform: 'yiji', status: 'active' },
    {
      platform: 'yiji',
      client: {
        apiUrl: 'https://order.x',
        adminApiUrl: 'https://admin.x',
        adminEmail: 'crm@x',
        adminPassword: 'p',
        onUsage,
      },
    },
  );

/**
 * CRM ACCOUNT FIRST, BACKUP TOKEN ONLY ON A REFUSAL (owner, 2026-10-21).
 *
 * Every admin call is made with the CRM's own Yiji account. The owner's token
 * is used for that one call only when the CRM account's login was REFUSED, or
 * the call was refused with 401 (after a re-login) or 403. A timeout, a
 * network error or a 5xx never reaches it. No test here talks to Yiji.
 */

const ADMIN = 'https://admin.x';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, auth: string | undefined) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ url, auth });
    return handler(url, auth);
  });
  vi.stubGlobal('fetch', f);
  return calls;
}

function client(opts: { backup?: string; usage?: YijiUsageEvent[]; sink?: () => void } = {}) {
  return new HttpYijiClient({
    baseUrl: 'https://order.x',
    adminUrl: ADMIN,
    adminEmail: 'crm@x',
    adminPassword: 'p',
    timeoutMs: 1000,
    ...(opts.backup ? { backupToken: opts.backup } : {}),
    onUsage: opts.sink ?? ((e) => opts.usage?.push(e)),
  });
}

const isLogin = (url: string) => url.endsWith('/api/Account/login');

afterEach(() => vi.unstubAllGlobals());

describe('CRM first', () => {
  it('signs in with the CRM account and never touches the backup when that works', async () => {
    const usage: YijiUsageEvent[] = [];
    const calls = stubFetch((url) => (isLogin(url) ? json({ token: 'CRM' }) : json({ ok: 1 })));
    const r = await client({ backup: 'OWNER', usage }).adminPost(
      '/api/CouponUser/AddUserCoupon',
      {},
    );
    expect(r).toEqual({ ok: 1 });
    expect(calls.map((c) => c.auth)).toEqual([undefined, 'Bearer CRM']);
    expect(calls.some((c) => c.auth === 'Bearer OWNER')).toBe(false);
    expect(usage.map((u) => [u.operation, u.account, u.outcome])).toEqual([
      ['login', 'crm', 'ok'],
      ['coupon.push', 'crm', 'ok'],
    ]);
  });

  it('a 401 re-signs the CRM account first; the backup is not needed when that works', async () => {
    let logins = 0;
    let first = true;
    const calls = stubFetch((url) => {
      if (isLogin(url)) return json({ token: `CRM${++logins}` });
      if (first) {
        first = false;
        return new Response('', { status: 401 });
      }
      return json([{ id: 'u1', phoneNumber: '+966501234567' }]);
    });
    const id = await client({ backup: 'OWNER' }).findCustomerIdByPhone('0501234567');
    expect(id).toBe('u1');
    expect(calls.map((c) => c.auth)).toEqual([undefined, 'Bearer CRM1', undefined, 'Bearer CRM2']);
  });
});

describe('backup on a refusal only', () => {
  it('a 403 from the CRM account is asked ONCE more with the backup, and recorded why', async () => {
    const usage: YijiUsageEvent[] = [];
    const calls = stubFetch((url, auth) => {
      if (isLogin(url)) return json({ token: 'CRM' });
      return auth === 'Bearer OWNER' ? json({ result: 1 }) : json({ title: 'Forbidden' }, 403);
    });
    const r = await client({ backup: 'OWNER', usage }).adminPost('/api/Coupon/AddCoupon', {});
    expect(r).toEqual({ result: 1 });
    expect(calls.map((c) => c.auth)).toEqual([undefined, 'Bearer CRM', 'Bearer OWNER']);
    const backup = usage.filter((u) => u.account === 'backup');
    expect(backup).toHaveLength(1);
    expect(backup[0]).toMatchObject({
      operation: 'coupon.create',
      outcome: 'ok',
      fallbackReason: 'crm account refused (403)',
    });
  });

  it('a 401 after the re-login goes to the backup', async () => {
    const calls = stubFetch((url, auth) => {
      if (isLogin(url)) return json({ token: 'CRM' });
      return auth === 'Bearer OWNER' ? json({ ok: 1 }) : new Response('', { status: 401 });
    });
    const usage: YijiUsageEvent[] = [];
    await client({ backup: 'OWNER', usage }).adminPost('/api/CouponUser/AddUserCoupon', {});
    expect(calls.map((c) => c.auth)).toEqual([
      undefined,
      'Bearer CRM',
      undefined,
      'Bearer CRM',
      'Bearer OWNER',
    ]);
    expect(usage.at(-1)?.fallbackReason).toBe('crm account refused (401) after a re-login');
  });

  it('a CRM login Yiji REFUSED goes to the backup', async () => {
    const usage: YijiUsageEvent[] = [];
    const calls = stubFetch((url) => (isLogin(url) ? json({}, 400) : json([])));
    await client({ backup: 'OWNER', usage }).findUserCoupon('u1', 'OPS-1');
    expect(calls.map((c) => c.auth)).toEqual([undefined, 'Bearer OWNER']);
    expect(usage[0]).toMatchObject({ operation: 'login', account: 'crm', outcome: 'refused' });
    expect(usage[1]).toMatchObject({ account: 'backup', operation: 'coupon.wallet' });
    expect(usage[1]!.fallbackReason).toMatch(/crm login refused/);
  });

  it('a NETWORK error never reaches the backup', async () => {
    const calls = stubFetch((url) => {
      if (isLogin(url)) return json({ token: 'CRM' });
      throw new TypeError('fetch failed');
    });
    const usage: YijiUsageEvent[] = [];
    await expect(
      client({ backup: 'OWNER', usage }).adminPost('/api/CouponUser/AddUserCoupon', {}),
    ).rejects.toMatchObject({ name: 'YijiUnavailableError' });
    expect(calls.some((c) => c.auth === 'Bearer OWNER')).toBe(false);
    expect(usage.at(-1)).toMatchObject({ account: 'crm', outcome: 'error', httpStatus: null });
  });

  it('a login that got NO answer never reaches the backup', async () => {
    const calls = stubFetch(() => {
      throw new TypeError('ECONNREFUSED');
    });
    await expect(client({ backup: 'OWNER' }).findUserCoupon('u1', 'X')).rejects.toMatchObject({
      name: 'YijiUnavailableError',
    });
    expect(calls).toHaveLength(1);
  });

  it('a 5xx never reaches the backup', async () => {
    const calls = stubFetch((url) =>
      isLogin(url) ? json({ token: 'CRM' }) : new Response('down', { status: 503 }),
    );
    await expect(
      client({ backup: 'OWNER' }).adminPost('/api/CouponUser/AddUserCoupon', {}),
    ).rejects.toMatchObject({ name: 'YijiUnavailableError' });
    expect(calls.some((c) => c.auth === 'Bearer OWNER')).toBe(false);
  });

  it('a 400 is Yiji refusing the REQUEST, not the account - no backup', async () => {
    const calls = stubFetch((url) =>
      isLogin(url) ? json({ token: 'CRM' }) : json({ exceptionMessage: 'bad' }, 400),
    );
    await expect(
      client({ backup: 'OWNER' }).adminPost('/api/CouponUser/AddUserCoupon', {}),
    ).rejects.toMatchObject({ name: 'YijiRefusedError', status: 400 });
    expect(calls.some((c) => c.auth === 'Bearer OWNER')).toBe(false);
  });
});

describe('without a backup token nothing changes', () => {
  it('a 403 is still a refusal from the CRM account', async () => {
    const calls = stubFetch((url) =>
      isLogin(url) ? json({ token: 'CRM' }) : json({ title: 'Forbidden' }, 403),
    );
    await expect(client().adminPost('/api/CouponUser/AddUserCoupon', {})).rejects.toMatchObject({
      name: 'YijiRefusedError',
      status: 403,
    });
    expect(calls).toHaveLength(2);
  });

  it('a refused login is still thrown', async () => {
    stubFetch(() => json({}, 401));
    await expect(client().findUserCoupon('u1', 'X')).rejects.toMatchObject({
      name: 'YijiLoginRefusedError',
    });
  });
});

describe('recording never breaks a call', () => {
  it('a sink that throws changes nothing', async () => {
    stubFetch((url) => (isLogin(url) ? json({ token: 'CRM' }) : json({ ok: 1 })));
    const r = await client({
      sink: () => {
        throw new Error('recorder exploded');
      },
    }).adminPost('/api/CouponUser/AddUserCoupon', {});
    expect(r).toEqual({ ok: 1 });
  });
});

describe('connectors stamp the vendor on each usage event', () => {
  it('vendor = the connector vendor platform id', async () => {
    stubFetch((url) =>
      isLogin(url) ? json({ token: 'CRM' }) : json([{ id: 'u1', phoneNumber: '+966501234567' }]),
    );
    const usage: YijiUsageEvent[] = [];
    const c = createYijiConnectorForTest('7', (e) => usage.push(e));
    await c.findCustomerIdByPhone!('0501234567');
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.vendor === '7')).toBe(true);
  });
});
