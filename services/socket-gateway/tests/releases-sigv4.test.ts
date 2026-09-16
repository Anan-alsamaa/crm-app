import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { signRequest, taskRoleCredentials } from '../src/releases.js';

/*
 * THE SIGNATURE IS EITHER RIGHT OR THE RELEASE BUTTON DOES NOTHING.
 *
 * A hand-rolled SigV4 signer fails at exactly one moment — when the owner
 * clicks Update now — and fails as an opaque 403 from AWS, which says nothing
 * about whether the fault is the signature or the IAM policy.
 *
 * So it is checked against a SECOND implementation written from the spec
 * below, sharing no code with the one under test. Agreement between two
 * independent implementations is the evidence; comparing an implementation
 * against itself proves nothing.
 */

/** An independent SigV4, written from the spec, for the header set we send. */
function referenceSignature(o: {
  method: string;
  host: string;
  path: string;
  service: string;
  region: string;
  body: string;
  amzDate: string;
  secretAccessKey: string;
}): string {
  const sha = (d: string) => createHash('sha256').update(d).digest('hex');
  const hm = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
  const ph = sha(o.body);
  const canonicalHeaders =
    ['host:' + o.host, 'x-amz-content-sha256:' + ph, 'x-amz-date:' + o.amzDate].join('\n') + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [o.method, o.path, '', canonicalHeaders, signedHeaders, ph].join('\n');
  const ds = o.amzDate.slice(0, 8);
  const scope = [ds, o.region, o.service, 'aws4_request'].join('/');
  const toSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha(canonical)].join('\n');
  let k = hm('AWS4' + o.secretAccessKey, ds);
  for (const part of [o.region, o.service, 'aws4_request']) k = hm(k, part);
  return hm(k, toSign).toString('hex');
}

describe('SigV4 — cross-checked against an independent implementation', () => {
  const SK = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const now = new Date('2015-08-30T12:36:00Z');
  const amzDate = '20150830T123600Z';

  /* The two calls a release actually makes, plus a plain GET as a control. */
  const cases = [
    {
      name: 'a control GET',
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      service: 'service',
      region: 'us-east-1',
      body: '',
    },
    {
      name: 'the S3 copy that promotes the build',
      method: 'PUT',
      host: 'crm-prod-agent-portal.s3.us-east-2.amazonaws.com',
      path: '/index.html',
      service: 's3',
      region: 'us-east-2',
      body: '',
    },
    {
      name: 'the CloudFront invalidation',
      method: 'POST',
      host: 'cloudfront.amazonaws.com',
      path: '/2020-05-31/distribution/E1/invalidation',
      service: 'cloudfront',
      region: 'us-east-1',
      body: '<InvalidationBatch/>',
    },
  ] as const;

  for (const c of cases) {
    it(`signs ${c.name} exactly as the reference does`, () => {
      const headers = signRequest({
        method: c.method,
        host: c.host,
        path: c.path,
        service: c.service,
        region: c.region,
        body: c.body,
        credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SK },
        now,
      });
      const signature = headers.Authorization.split('Signature=')[1];
      expect(signature).toBe(referenceSignature({ ...c, amzDate, secretAccessKey: SK }));
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('puts the credential scope and signed headers in the Authorization header', () => {
    const headers = signRequest({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      service: 'service',
      region: 'us-east-1',
      body: '',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SK },
      now,
    });
    expect(headers.Authorization).toContain(
      'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request',
    );
    expect(headers.Authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
    expect(headers['x-amz-date']).toBe(amzDate);
  });

  it('includes the session token in the SIGNED headers, not just the sent ones', () => {
    // ECS task-role credentials always carry one, and AWS rejects a request
    // that sends the token without signing it.
    const headers = signRequest({
      method: 'PUT',
      host: 'b.s3.us-east-2.amazonaws.com',
      path: '/index.html',
      service: 's3',
      region: 'us-east-2',
      body: '',
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'TOK' },
      now,
    });
    expect(headers['x-amz-security-token']).toBe('TOK');
    expect(headers.Authorization).toContain('x-amz-security-token');
  });

  it('signs the body, so a different payload gives a different signature', () => {
    // Guards against a signer that ignores the body — it would pass a smoke
    // test and fail every real POST.
    const base = {
      method: 'POST',
      host: 'cloudfront.amazonaws.com',
      path: '/2020-05-31/distribution/E1/invalidation',
      service: 'cloudfront',
      region: 'us-east-1',
      credentials: { accessKeyId: 'A', secretAccessKey: 'S' },
      now,
    } as const;
    expect(signRequest({ ...base, body: '<a/>' }).Authorization).not.toBe(
      signRequest({ ...base, body: '<b/>' }).Authorization,
    );
  });
});

describe('task-role credentials', () => {
  it('prefers an explicit key pair, which is how this runs outside ECS', async () => {
    const creds = await taskRoleCredentials({
      AWS_ACCESS_KEY_ID: 'AK',
      AWS_SECRET_ACCESS_KEY: 'SK',
      AWS_SESSION_TOKEN: 'ST',
    } as NodeJS.ProcessEnv);
    expect(creds).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' });
  });

  it('returns null when there is no credential source at all', async () => {
    // Fails closed: the endpoint then reports it cannot release, rather than
    // sending an unsigned request and surfacing an opaque AWS error.
    expect(await taskRoleCredentials({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
