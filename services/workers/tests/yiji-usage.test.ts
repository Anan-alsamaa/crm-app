import { describe, it, expect, vi } from 'vitest';
import type { YijiUsageEvent } from '@yiji/shared-types';
import { createYijiCouponRemover } from '../src/lib/yiji-coupon-remover.js';
import { purgeYijiUsage, scheduleYijiUsageRetention } from '../src/processors/yiji-usage.js';
import { roles } from '../../../directus/bootstrap/src/roles.js';
import { collections } from '../../../directus/bootstrap/src/collections.js';

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ op: 'readItems', collection, opts }),
  deleteItems: (collection: string, keys: unknown) => ({ op: 'deleteItems', collection, keys }),
  createItems: (collection: string, items: unknown) => ({ op: 'createItems', collection, items }),
}));

/**
 * Coupon removal with the CRM's OWN Yiji account first and the owner's token
 * as a BACKUP only (owner, 2026-10-21), every call recorded in
 * `yiji_api_usage`, which the workers alone prune after 90 days.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(handler: (url: string, auth: string | undefined) => Response) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    calls.push({ url, auth });
    return handler(url, auth);
  });
  return { f: f as unknown as typeof fetch, calls };
}
const isLogin = (url: string) => url.endsWith('/api/Account/login');

function remover(
  f: typeof fetch,
  extra: Partial<Parameters<typeof createYijiCouponRemover>[0]> = {},
  usage: YijiUsageEvent[] = [],
) {
  return createYijiCouponRemover({
    adminApiUrl: 'https://admin.x',
    adminEmail: 'crm@x',
    adminPassword: 'p',
    fetchImpl: f,
    onUsage: (e) => usage.push(e),
    ...extra,
  })!;
}

describe('coupon removal: CRM account first, backup on a refusal only', () => {
  it('uses the CRM account FIRST even with a backup configured', async () => {
    const usage: YijiUsageEvent[] = [];
    const { f, calls } = fakeFetch((url) =>
      isLogin(url) ? json({ token: 'CRM' }) : json({ result: 1 }),
    );
    await remover(f, { backupToken: 'OWNER' }, usage).removeGrant('27507');
    expect(calls.map((c) => c.auth)).toEqual([undefined, 'Bearer CRM']);
    expect(usage.map((u) => `${u.operation}:${u.account}:${u.outcome}`)).toEqual([
      'login:crm:ok',
      'coupon.remove:crm:ok',
    ]);
  });

  it('a 403 from the CRM account (its role) retries ONCE with the backup', async () => {
    const usage: YijiUsageEvent[] = [];
    const { f, calls } = fakeFetch((url, auth) => {
      if (isLogin(url)) return json({ token: 'CRM' });
      return auth === 'Bearer OWNER' ? json({ result: 1 }) : new Response('', { status: 403 });
    });
    await remover(f, { backupToken: 'OWNER' }, usage).removeGrant('27507');
    expect(calls.map((c) => c.auth)).toEqual([undefined, 'Bearer CRM', 'Bearer OWNER']);
    expect(usage.at(-2)).toMatchObject({ account: 'crm', outcome: 'refused', httpStatus: 403 });
    expect(usage.at(-1)).toMatchObject({
      operation: 'coupon.remove',
      account: 'backup',
      outcome: 'ok',
      fallbackReason: 'crm account refused (403)',
    });
  });

  it('the old YIJI_COUPON_REMOVE_TOKEN option still works - as the backup', async () => {
    const { f, calls } = fakeFetch((url, auth) => {
      if (isLogin(url)) return json({ token: 'CRM' });
      return auth === 'Bearer OLD' ? json({ result: 1 }) : new Response('', { status: 403 });
    });
    await remover(f, { removeToken: 'Bearer OLD' }).removeGrant('1');
    expect(calls.map((c) => c.auth)).toEqual([undefined, 'Bearer CRM', 'Bearer OLD']);
  });

  it('a refused CRM login goes to the backup', async () => {
    const usage: YijiUsageEvent[] = [];
    const { f, calls } = fakeFetch((url) => (isLogin(url) ? json({}, 400) : json({ result: 1 })));
    await remover(f, { backupToken: 'OWNER' }, usage).removeGrant('1');
    expect(calls.map((c) => c.auth)).toEqual([undefined, 'Bearer OWNER']);
    expect(usage.at(-1)?.fallbackReason).toMatch(/crm login refused/);
  });

  it('a NETWORK error is never retried with the backup', async () => {
    const usage: YijiUsageEvent[] = [];
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push((init.headers as Record<string, string>).authorization ?? 'login');
      if (isLogin(url)) return json({ token: 'CRM' });
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      remover(f, { backupToken: 'OWNER' }, usage).removeGrant('1'),
    ).rejects.toMatchObject({
      name: 'YijiUnavailableError',
    });
    expect(calls).toEqual(['login', 'Bearer CRM']);
    expect(usage.at(-1)).toMatchObject({ account: 'crm', outcome: 'error', httpStatus: null });
  });

  it('without a backup a 403 stays a refusal (unchanged)', async () => {
    const { f, calls } = fakeFetch((url) =>
      isLogin(url) ? json({ token: 'CRM' }) : new Response('', { status: 403 }),
    );
    await expect(remover(f).removeGrant('1')).rejects.toMatchObject({
      name: 'YijiRefusedError',
      status: 403,
    });
    expect(calls).toHaveLength(2);
  });

  it('a recorder that throws never breaks the removal', async () => {
    const { f } = fakeFetch((url) => (isLogin(url) ? json({ token: 'CRM' }) : json({ result: 1 })));
    const r = createYijiCouponRemover({
      adminApiUrl: 'https://admin.x',
      adminEmail: 'crm@x',
      adminPassword: 'p',
      fetchImpl: f,
      onUsage: () => {
        throw new Error('recorder exploded');
      },
    })!;
    await expect(r.removeGrant('1')).resolves.toBeUndefined();
  });
});

describe('yiji_api_usage retention', () => {
  const logger = { info: vi.fn(), warn: vi.fn() };

  it('deletes rows older than 90 days, in id batches, until a short page', async () => {
    const reqs: Array<{ op: string; opts?: { filter?: unknown; limit?: number }; keys?: unknown }> =
      [];
    let page = 0;
    const directus = {
      request: vi.fn(async (r: { op: string }) => {
        reqs.push(r as never);
        if (r.op === 'readItems') {
          page += 1;
          return page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
        }
        return undefined;
      }),
    };
    const n = await purgeYijiUsage({
      directus: directus as never,
      logger: logger as never,
      now: () => new Date('2026-10-21T00:00:00Z'),
      batchSize: 2,
    });
    expect(n).toBe(3);
    const read = reqs.find((r) => r.op === 'readItems')!;
    expect(read.opts!.filter).toEqual({ date_created: { _lt: '2026-07-23T00:00:00.000Z' } });
    expect(reqs.filter((r) => r.op === 'deleteItems').map((r) => r.keys)).toEqual([
      ['1', '2'],
      ['3'],
    ]);
  });

  it('a failed purge is logged, never thrown', async () => {
    const directus = {
      request: vi.fn(async () => {
        throw new Error('403');
      }),
    };
    await expect(
      purgeYijiUsage({ directus: directus as never, logger: logger as never }),
    ).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is ONE job scheduler; 0 removes it', async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn() };
    await scheduleYijiUsageRetention(queue as never, 86_400_000);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'yiji-usage-retention',
      { every: 86_400_000 },
      expect.objectContaining({ name: 'yiji_usage_retention' }),
    );
    await scheduleYijiUsageRetention(queue as never, 0);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('yiji-usage-retention');
  });
});

describe('yiji_api_usage schema + permissions', () => {
  it('is a collection with the agreed fields', () => {
    const spec = collections.find((c) => c.collection === 'yiji_api_usage');
    expect(spec?.fields.map((f) => f.field)).toEqual([
      'service',
      'operation',
      'account',
      'outcome',
      'http_status',
      'duration_ms',
      'fallback_reason',
      'error',
      'vendor',
    ]);
  });

  it('the three services write it; only the workers delete; no person-role holds it', () => {
    const grants = roles.flatMap((r) =>
      (r.permissions ?? [])
        .filter((p) => p.collection === 'yiji_api_usage')
        .map((p) => `${r.name}:${p.action}`),
    );
    for (const svc of ['svc-workers', 'svc-socket-gateway', 'svc-ai-gateway']) {
      expect(grants).toContain(`${svc}:create`);
    }
    expect(grants.filter((g) => g.endsWith(':delete'))).toEqual(['svc-workers:delete']);
    expect(grants.filter((g) => g.endsWith(':update'))).toEqual([]);
    expect(grants.every((g) => g.startsWith('svc-'))).toBe(true);
  });
});
