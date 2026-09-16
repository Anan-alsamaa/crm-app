import { describe, it, expect, vi } from 'vitest';
import { parseReleaseTargets, releasePortal } from '../src/releases.js';

/*
 * RELEASING IS TWO REQUESTS, AND THEIR ORDER IS NOT INTERCHANGEABLE.
 *
 * Copy `pending/index.html` over the live one, THEN invalidate. An
 * invalidation issued first would clear the cache and immediately refill it
 * with the OLD file — a release that reports success and changes nothing,
 * which is the worst possible outcome for a button whose entire purpose is to
 * be the moment production changes.
 */

const creds = { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' };
const target = { bucket: 'crm-prod-agent-portal', distributionId: 'E1', region: 'us-east-2' };
const ok = () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response;

describe('parseReleaseTargets', () => {
  it('reads one bucket:distribution pair per portal', () => {
    expect(parseReleaseTargets('a-bucket:E1,b-bucket:E2', 'us-east-2')).toEqual([
      { bucket: 'a-bucket', distributionId: 'E1', region: 'us-east-2' },
      { bucket: 'b-bucket', distributionId: 'E2', region: 'us-east-2' },
    ]);
  });

  it('tolerates the spacing people actually type', () => {
    expect(parseReleaseTargets(' a:E1 , b:E2 ', 'us-east-2')).toHaveLength(2);
  });

  it('DROPS a malformed pair rather than guessing at it', () => {
    /*
     * A half-understood entry would release one portal and not the other, or
     * invalidate a distribution that does not front the bucket just written.
     * Both look like a successful release. Dropping is what makes the endpoint
     * answer "not configured" instead of releasing something wrong.
     */
    expect(parseReleaseTargets('just-a-bucket', 'us-east-2')).toEqual([]);
    expect(parseReleaseTargets(':E1', 'us-east-2')).toEqual([]);
    expect(parseReleaseTargets('a:', 'us-east-2')).toEqual([]);
    expect(parseReleaseTargets('a:E1:extra', 'us-east-2')).toEqual([]);
  });

  it('treats an empty setting as "no targets", which the endpoint reports as 503', () => {
    expect(parseReleaseTargets('', 'us-east-2')).toEqual([]);
    expect(parseReleaseTargets('  ,  ', 'us-east-2')).toEqual([]);
  });
});

describe('releasePortal', () => {
  it('copies the parked build over the live one, THEN invalidates', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return ok();
    }) as unknown as typeof fetch;

    const res = await releasePortal(target, creds, fetchImpl);

    expect(res).toEqual({ ok: true });
    expect(calls[0]).toContain('crm-prod-agent-portal.s3.us-east-2.amazonaws.com/index.html');
    expect(calls[1]).toContain('cloudfront.amazonaws.com');
    expect(calls[1]).toContain('/distribution/E1/invalidation');
  });

  it('names the parked file as the copy source, and keeps index.html uncacheable', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') headers = init.headers as Record<string, string>;
      return ok();
    }) as unknown as typeof fetch;

    await releasePortal(target, creds, fetchImpl);

    expect(headers['x-amz-copy-source']).toBe('/crm-prod-agent-portal/pending/index.html');
    /* A copy does NOT inherit the source's metadata unless told to, and an
       index.html that becomes cacheable is a release that reaches some users
       and not others, for a year. */
    expect(headers['x-amz-metadata-directive']).toBe('REPLACE');
    expect(headers['cache-control']).toBe('no-cache');
  });

  it('does NOT invalidate when the copy failed — nothing changed to publish', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return { ok: false, status: 403, text: async () => 'AccessDenied' } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await releasePortal(target, creds, fetchImpl);

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1); // the copy only
    if (!res.ok) expect(res.error).toContain('403');
  });

  it('SUCCEEDS with a warning when only the invalidation failed', async () => {
    /*
     * `ok` answers one question: is the new build live? The copy decides that,
     * and it already happened — so reporting failure here would be untrue, and
     * worse, would leave the banner up for ever offering an update that has
     * been applied.
     *
     * This is the EXPECTED path on production today: the gateway's task role
     * has S3 through a bucket policy but no cloudfront:CreateInvalidation,
     * which needs an IAM change nobody on this account can make. `index.html`
     * is served `no-cache`, so the build reaches people as browsers
     * revalidate — minutes, not instantly.
     */
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('cloudfront')
        ? ({ ok: false, status: 403, text: async () => 'AccessDenied' } as unknown as Response)
        : ok(),
    ) as unknown as typeof fetch;

    const res = await releasePortal(target, creds, fetchImpl);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warning).toContain('the CDN cache was not cleared');
  });

  it('signs both requests with the session token ECS credentials carry', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return ok();
    }) as unknown as typeof fetch;

    await releasePortal(target, creds, fetchImpl);

    for (const h of seen) {
      expect(h['x-amz-security-token']).toBe('ST');
      expect(h.Authorization).toContain('AWS4-HMAC-SHA256');
    }
  });
});
