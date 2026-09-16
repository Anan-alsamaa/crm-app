import { describe, it, expect, vi } from 'vitest';
import { parseReleaseTargets, readParkedBuild, releasePortal } from '../src/releases.js';

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
    // A FOURTH part means something this does not implement.
    expect(parseReleaseTargets('a:E1:index.html:extra', 'us-east-2')).toEqual([]);
  });

  it('reads the optional file list, which is what the widget needs', () => {
    /*
     * The chat widget serves three entry points — `index.html`,
     * `walk-in.html`, and the extensionless `walk-in` key a QR poster points
     * at — all naming the same hashed assets. They must release together or a
     * customer scanning a poster gets a different build from one opening the
     * chat link.
     */
    expect(parseReleaseTargets('w-bucket:E9:index.html|walk-in.html|walk-in', 'us-east-2')).toEqual(
      [
        {
          bucket: 'w-bucket',
          distributionId: 'E9',
          region: 'us-east-2',
          files: ['index.html', 'walk-in.html', 'walk-in'],
        },
      ],
    );
  });

  it('leaves `files` unset for a portal, which releases index.html alone', () => {
    const [t] = parseReleaseTargets('crm-prod-agent-portal:E1', 'us-east-2');
    expect(t?.files).toBeUndefined();
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

  it('is a plain success when the purge is REFUSED — that is the expected path', async () => {
    /*
     * 403 is what production actually returns: `cloudfront:CreateInvalidation`
     * is not granted to the task role and cannot be, because every AWS user on
     * this account has IAMReadOnlyAccess.
     *
     * It does not matter. The entry points are served `no-cache` and the edge
     * revalidates them against S3 on every request — verified against
     * production by rewriting the origin object and watching CloudFront pick
     * up the new ETag with no invalidation. The copy IS the release.
     *
     * So no warning: telling the owner something went wrong on every single
     * release would train them to ignore the one message this button shows,
     * which is how a real failure later goes unread.
     */
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('cloudfront')
        ? ({ ok: false, status: 403, text: async () => 'AccessDenied' } as unknown as Response)
        : ok(),
    ) as unknown as typeof fetch;

    const res = await releasePortal(target, creds, fetchImpl);

    expect(res).toEqual({ ok: true });
  });

  it('still warns when the purge fails for a reason nobody expects', async () => {
    // A 500 is not the known-and-accepted refusal, so it is worth saying out
    // loud — the distinction is what keeps the quiet case meaningful.
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('cloudfront')
        ? ({ ok: false, status: 500, text: async () => 'boom' } as unknown as Response)
        : ok(),
    ) as unknown as typeof fetch;

    const res = await releasePortal(target, creds, fetchImpl);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warning).toContain('the CDN cache was not cleared');
  });

  it('promotes EVERY file of a multi-page surface, then purges them all', async () => {
    /*
     * The chat widget's three entry points must move together. Releasing some
     * and not others would serve one build to a customer who scans a QR poster
     * and another to one who opens the chat link — from the same deploy, with
     * nothing to indicate anything is wrong.
     */
    const widget = {
      bucket: 'crm-prod-widget-408568863712',
      distributionId: 'E9',
      region: 'us-east-2',
      files: ['index.html', 'walk-in.html', 'walk-in'],
    };
    const copies: string[] = [];
    let invalidation = '';
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PUT') copies.push(u.split('.com')[1] ?? u);
      if (u.includes('cloudfront')) invalidation = String(init?.body ?? '');
      return ok();
    }) as unknown as typeof fetch;

    const res = await releasePortal(widget, creds, fetchImpl);

    expect(res.ok).toBe(true);
    expect(copies).toEqual(['/index.html', '/walk-in.html', '/walk-in']);
    // `/` is a separate cache object from `/index.html` — a customer opening
    // the bare origin would otherwise keep the old page.
    for (const p of ['/', '/index.html', '/walk-in.html', '/walk-in']) {
      expect(invalidation).toContain(`<Path>${p}</Path>`);
    }
    expect(invalidation).toContain('<Quantity>4</Quantity>');
  });

  it('stops at the first file that fails, leaving the rest untouched', async () => {
    // A half-release is far easier to reason about when it is the FIRST half
    // that landed.
    const widget = { ...target, files: ['index.html', 'walk-in.html', 'walk-in'] };
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PUT') calls.push(u);
      return u.includes('walk-in.html')
        ? ({ ok: false, status: 403, text: async () => 'AccessDenied' } as unknown as Response)
        : ok();
    }) as unknown as typeof fetch;

    const res = await releasePortal(widget, creds, fetchImpl);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('walk-in.html');
    expect(calls).toHaveLength(2); // index.html, then the one that failed
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

/*
 * WHAT COUNTS AS "PENDING" — AND WHY BOTH ENDPOINTS MUST AGREE.
 *
 * CI records a published build over HTTP, best effort, so the recorded list can
 * be empty while a build really is parked. `GET /jobs/releases` falls back to
 * the bucket for exactly that reason — and `POST /jobs/releases/apply` did NOT,
 * so the banner offered an update, pressing it did nothing, and it reported
 * success. Found on the first real release (2026-09-16).
 *
 * `readParkedBuild` is the shared answer. These pin its behaviour so the two
 * endpoints cannot drift apart again.
 */
describe('readParkedBuild — the bucket is the fact', () => {
  const target = { bucket: 'crm-prod-admin-portal', distributionId: 'E1', region: 'us-east-2' };
  const creds = { accessKeyId: 'AK', secretAccessKey: 'SK' };

  it('reads the bundle out of a parked index.html', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '<script type="module" crossorigin src="/assets/index-xCc40TZI.js"></script>',
    })) as unknown as typeof fetch;

    expect(await readParkedBuild(target, creds, fetchImpl)).toEqual({
      bundle: '/assets/index-xCc40TZI.js',
    });
  });

  it('reads the version CI wrote beside the parked page', async () => {
    /*
     * CI cannot call the gateway: this repo has NO secrets — it authenticates
     * to AWS by OIDC role assumption — so there is no token to give it. The
     * version travels in the bucket instead, written with the S3 access the
     * deploy already has.
     */
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('release.json')
        ? ({
            ok: true,
            status: 200,
            json: async () => ({
              version: 'v1.2.3',
              commit: 'abc1234',
              bundle: '/assets/index-A.js',
              app: 'agent',
            }),
          } as unknown as Response)
        : ({
            ok: true,
            status: 200,
            text: async () => '<script src="/assets/index-A.js"></script>',
          } as unknown as Response),
    ) as unknown as typeof fetch;

    const parked = await readParkedBuild(target, creds, fetchImpl);
    expect(parked).toMatchObject({ bundle: '/assets/index-A.js', version: 'v1.2.3' });
  });

  it('IGNORES a stale release.json that describes a different build', async () => {
    // An earlier deploy's metadata left behind would otherwise label the parked
    // page with a version it is not — worse than having no version at all.
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('release.json')
        ? ({
            ok: true,
            status: 200,
            json: async () => ({ version: 'v0.0.1', bundle: '/assets/index-OLD.js' }),
          } as unknown as Response)
        : ({
            ok: true,
            status: 200,
            text: async () => '<script src="/assets/index-NEW.js"></script>',
          } as unknown as Response),
    ) as unknown as typeof fetch;

    const parked = await readParkedBuild(target, creds, fetchImpl);
    expect(parked).toEqual({ bundle: '/assets/index-NEW.js' });
  });

  it('is still releasable when the version file is missing', async () => {
    // The page is what makes a build releasable; the version only names it.
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('release.json')
        ? ({ ok: false, status: 404, text: async () => '' } as unknown as Response)
        : ({
            ok: true,
            status: 200,
            text: async () => '<script src="/assets/index-A.js"></script>',
          } as unknown as Response),
    ) as unknown as typeof fetch;

    expect(await readParkedBuild(target, creds, fetchImpl)).toEqual({
      bundle: '/assets/index-A.js',
    });
  });

  it('returns null on 404 — nothing published since the last release', async () => {
    // The ordinary state, and it must not read as an error.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
    })) as unknown as typeof fetch;

    expect(await readParkedBuild(target, creds, fetchImpl)).toBeNull();
  });

  it('returns null when the parked file names no bundle', async () => {
    // A truncated or half-written upload must not be offered as releasable.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body>nothing here</body></html>',
    })) as unknown as typeof fetch;

    expect(await readParkedBuild(target, creds, fetchImpl)).toBeNull();
  });

  it('stays quiet when S3 is unreachable rather than failing the page', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    expect(await readParkedBuild(target, creds, fetchImpl)).toBeNull();
  });
});
