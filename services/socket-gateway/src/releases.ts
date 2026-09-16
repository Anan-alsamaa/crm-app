import { createHash, createHmac } from 'node:crypto';

/*
 * RELEASING A PUBLISHED BUILD.
 *
 * A deploy publishes: it uploads the new hashed assets and parks the new entry
 * point at `pending/index.html`, leaving the live `index.html` alone. Nobody
 * sees anything. This is the other half — the administrator's Update now —
 * which copies the parked file over the live one and invalidates it.
 *
 * `index.html` is served `no-cache` and names content-hashed assets, so that
 * ONE COPY is the whole release. Both builds' assets already sit in the bucket
 * side by side, which is why the publish step stopped passing `--delete`.
 *
 * NO AWS SDK. Two signed requests do not justify adding the SDK to a
 * public-facing service that currently has no AWS dependency at all — more
 * code reachable from the internet, for a CopyObject and a POST. SigV4 is
 * about sixty lines and is exercised by its own tests.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present on ECS task-role credentials, absent for a static key pair. */
  sessionToken?: string;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** `20260916T093000Z` and `20260916`, the two stamps SigV4 wants. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Sign a request with SigV4 and return the headers to send.
 *
 * Only what these two calls need: no query signing, no chunked payloads.
 * Keeping it narrow is the point — a general-purpose signer would be more
 * surface than the feature deserves.
 */
export function signRequest(opts: {
  method: string;
  host: string;
  path: string;
  service: string;
  region: string;
  body: string;
  credentials: AwsCredentials;
  headers?: Record<string, string>;
  now?: Date;
}): Record<string, string> {
  const { method, host, path, service, region, body, credentials } = opts;
  const { amzDate, dateStamp } = stamps(opts.now ?? new Date());
  const payloadHash = sha256(body);

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    ...(opts.headers ?? {}),
  };

  // Canonical headers are sorted by lowercased name, each `name:trimmed-value`.
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders =
    names
      .map((n) => {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === n)!;
        return `${n}:${String(headers[key]).trim()}`;
      })
      .join('\n') + '\n';
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    path,
    '', // no query string on either call
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const toSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  const signature = hmac(key, toSign).toString('hex');

  return {
    ...headers,
    Authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Credentials from the ECS task role.
 *
 * ECS publishes them on a link-local endpoint named by
 * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. They ROTATE, so they are fetched
 * per release rather than cached — a release happens a few times a week, and
 * a stale cached credential would fail exactly when somebody is watching.
 */
export async function taskRoleCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AwsCredentials | null> {
  // A static pair wins when present: that is how this runs outside ECS.
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    };
  }
  const rel = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const url = rel ? `http://169.254.170.2${rel}` : full;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
    };
    if (!j.AccessKeyId || !j.SecretAccessKey) return null;
    return {
      accessKeyId: j.AccessKeyId,
      secretAccessKey: j.SecretAccessKey,
      ...(j.Token ? { sessionToken: j.Token } : {}),
    };
  } catch {
    return null;
  }
}

export interface ReleaseTarget {
  bucket: string;
  distributionId: string;
  region: string;
  /**
   * The files a release promotes from `pending/`, relative to the bucket root.
   *
   * One for a portal; THREE for the chat widget, which serves `index.html`,
   * `walk-in.html` and an extensionless `walk-in` key for the QR poster. All of
   * them name the same hashed assets, so releasing some and not others would
   * serve two different builds depending on which door a customer came
   * through.
   *
   * Defaults to `index.html`, which is every portal.
   */
  files?: string[];
}

/** What a release promotes when the target does not say otherwise. */
export const DEFAULT_RELEASE_FILES = ['index.html'];

/**
 * Parse `RELEASE_TARGETS` — comma-separated `bucket:distribution` pairs.
 *
 * STRICT ON PURPOSE. A half-understood value here would release one portal and
 * not the other, or invalidate a distribution that does not front the bucket
 * just written — both of which look like a successful release and are not. So
 * anything malformed is dropped rather than guessed at, and a caller that ends
 * up with an empty list reports "not configured" instead of releasing nothing
 * quietly.
 */
export function parseReleaseTargets(raw: string, region: string): ReleaseTarget[] {
  const out: ReleaseTarget[] = [];
  for (const piece of raw.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    const [bucket, distributionId, files, ...rest] = entry.split(':').map((p) => p.trim());
    // Two parts required, a third optional. A FOURTH means somebody meant
    // something this does not implement, which is worth dropping rather than
    // half-honouring.
    if (!bucket || !distributionId || rest.length > 0) continue;
    /*
     * The optional third part lists the files to promote, separated by `|`.
     *
     * The widget needs it: it serves `index.html`, `walk-in.html` and an
     * extensionless `walk-in` key, all naming the same hashed assets, so they
     * release together or a customer scanning a QR poster gets a different
     * build from one opening the chat link. A portal omits it and gets
     * `index.html`.
     */
    const list = (files ?? '')
      .split('|')
      .map((f) => f.trim())
      .filter(Boolean);
    out.push({
      bucket,
      distributionId,
      region,
      ...(list.length > 0 ? { files: list } : {}),
    });
  }
  return out;
}

/**
 * Promote `pending/index.html` to `index.html`, then invalidate it.
 *
 * ORDER MATTERS AND IS NOT INTERCHANGEABLE. Copy first, invalidate second: an
 * invalidation issued before the copy would clear the cache and immediately
 * refill it with the OLD file, and the release would silently do nothing while
 * reporting success.
 *
 * The copy is server-side (S3 CopyObject), so no bytes pass through this
 * service and a release is two small requests regardless of bundle size.
 */
/**
 * Is there a parked build, and which bundle does it name?
 *
 * The pending list is normally written by CI. This reads the BUCKET instead,
 * and exists because those two facts can disagree: CI records the build over
 * HTTP, best-effort, so a missing secret or an unreachable gateway leaves a
 * build genuinely published and completely invisible — no banner, no way to
 * release it, and no error anywhere. The truth is what is in the bucket.
 *
 * Used as a fallback when the recorded list is empty, so "published" always
 * means the same thing: the file is there.
 */
export async function readParkedBuild(
  target: ReleaseTarget,
  credentials: AwsCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bundle: string } | null> {
  const host = `${target.bucket}.s3.${target.region}.amazonaws.com`;
  const path = '/pending/index.html';
  try {
    const res = await fetchImpl(`https://${host}${path}`, {
      method: 'GET',
      headers: signRequest({
        method: 'GET',
        host,
        path,
        service: 's3',
        region: target.region,
        body: '',
        credentials,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // 404 is the ordinary state — nothing published since the last release.
    if (!res.ok) return null;
    const html = await res.text();
    const bundle = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0];
    return bundle ? { bundle } : null;
  } catch {
    return null;
  }
}

export async function releasePortal(
  target: ReleaseTarget,
  credentials: AwsCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<
  /* `ok` answers one question: IS THE NEW BUILD LIVE? The copy decides that.
     A failed invalidation is reported through `warning` instead, because by
     then the release HAS happened — `index.html` is served `no-cache`, so the
     new build reaches people as their browser revalidates, minutes rather than
     instantly. Calling that a failure would leave the banner up for ever
     offering an update that is already applied. */
  { ok: true; warning?: string } | { ok: false; error: string }
> {
  const host = `${target.bucket}.s3.${target.region}.amazonaws.com`;
  const files = target.files ?? DEFAULT_RELEASE_FILES;

  /*
   * Every file of this surface, promoted in turn.
   *
   * A portal has one; the widget has three, and they must all move or a
   * customer scanning a QR poster would get a page from a different build than
   * one opening the chat link. Sequentially, stopping at the first failure:
   * a half-release is far easier to reason about when it is the FIRST half
   * that landed.
   */
  for (const file of files) {
    const copyHeaders = signRequest({
      method: 'PUT',
      host,
      path: `/${file}`,
      service: 's3',
      region: target.region,
      body: '',
      credentials,
      headers: {
        /* The source must be bucket-qualified. */
        'x-amz-copy-source': `/${target.bucket}/pending/${file}`,
        /* Carried explicitly: a copy does NOT inherit the source's metadata
           unless told to, and an entry point that becomes cacheable is a
           release that reaches some users and not others, for a year. */
        'x-amz-metadata-directive': 'REPLACE',
        'cache-control': 'no-cache',
        'content-type': 'text/html; charset=utf-8',
      },
    });

    try {
      const copy = await fetchImpl(`https://${host}/${file}`, {
        method: 'PUT',
        headers: copyHeaders,
        signal: AbortSignal.timeout(20_000),
      });
      if (!copy.ok) {
        const body = await copy.text().catch(() => '');
        return {
          ok: false,
          error: `s3 copy of ${file} failed (${copy.status}): ${body.slice(0, 200)}`,
        };
      }
    } catch (err) {
      return { ok: false, error: `s3 copy of ${file} failed: ${(err as Error).message}` };
    }
  }

  /* CloudFront is a global service and signs against us-east-1 regardless of
     where anything else lives. */
  const cfHost = 'cloudfront.amazonaws.com';
  const cfPath = `/2020-05-31/distribution/${target.distributionId}/invalidation`;
  /*
   * Purge EVERY path this release touched, plus `/` itself.
   *
   * `/` is not the same cache object as `/index.html` — a customer opening the
   * bare origin would keep getting the old page while somebody who typed the
   * full path got the new one. The widget adds `/walk-in.html` and `/walk-in`,
   * which is the QR poster's extensionless key.
   */
  const paths = [...new Set(['/', ...files.map((f) => `/${f}`)])];
  const cfBody =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">' +
    `<Paths><Quantity>${paths.length}</Quantity><Items>` +
    paths.map((p) => `<Path>${p}</Path>`).join('') +
    '</Items></Paths>' +
    `<CallerReference>release-${Date.now()}</CallerReference>` +
    '</InvalidationBatch>';

  try {
    const inv = await fetchImpl(`https://${cfHost}${cfPath}`, {
      method: 'POST',
      headers: signRequest({
        method: 'POST',
        host: cfHost,
        path: cfPath,
        service: 'cloudfront',
        region: 'us-east-1',
        body: cfBody,
        credentials,
        headers: { 'content-type': 'text/xml' },
      }),
      body: cfBody,
      signal: AbortSignal.timeout(20_000),
    });
    if (!inv.ok) {
      const body = await inv.text().catch(() => '');
      /* The copy already happened, so the new build IS live at the origin —
         it will simply take up to the cache TTL to reach everyone. Reported as
         a partial success rather than a failure, because telling the owner
         "release failed" after the file has moved would be untrue. */
      return {
        ok: true,
        warning: `the CDN cache was not cleared (${inv.status}): ${body.slice(0, 200)}`,
      };
    }
  } catch (err) {
    return { ok: true, warning: `the CDN cache was not cleared: ${(err as Error).message}` };
  }

  return { ok: true };
}

/**
 * A human name for the surface a bucket holds.
 *
 * Used in the banner, so it has to read as the thing the owner is about to
 * change rather than as an S3 bucket name. Derived from the bucket because
 * that is what the configuration already carries — adding a fourth field to
 * `RELEASE_TARGETS` would be one more thing to keep in step for a label.
 *
 * Falls back to the bucket name rather than guessing: an unrecognised bucket
 * shown honestly is better than one confidently mislabelled as a portal it is
 * not.
 */
export function releaseSurfaceName(bucket: string): string {
  if (bucket.includes('admin-portal')) return 'admin';
  if (bucket.includes('agent-portal')) return 'agent';
  if (bucket.includes('widget')) return 'chat widget';
  return bucket;
}
