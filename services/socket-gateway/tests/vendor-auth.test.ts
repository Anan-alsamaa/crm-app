import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import type { Logger } from 'pino';
import { createEnvVendorSecrets } from '@yiji/shared-types';
import { createVendorJwtSecrets, registerVendorWebhooks } from '../src/vendor-auth.js';
import { createVendorVerifier, CustomerTokenError } from '../src/auth/customer-jwt.js';
import { resolveCustomerClaims } from '../src/connection.js';
import { signWebhook } from '../src/webhook.js';

/**
 * MV-3 (EMA-72): every vendor has its own webhook secret and chat-login
 * secret, and no vendor can authenticate as another.
 */

const YIJI_JWT = 'yiji-jwt-secret-that-is-long-enough-for-hs256-xx';
const ACME_JWT = 'acme-jwt-secret-that-is-long-enough-for-hs256-xx';
const env = {
  YIJI_JWT_SECRET: YIJI_JWT,
  YIJI_WEBHOOK_SECRET: 'yiji-wh',
  VENDOR_ACME_JWT_SECRET: ACME_JWT,
  VENDOR_ACME_WEBHOOK_SECRET: 'acme-wh',
};
const secrets = createEnvVendorSecrets(env);
const silent = { info: vi.fn(), warn: vi.fn() };

/* ── webhooks ───────────────────────────────────────────────────── */

function buildApp(over: Partial<Parameters<typeof registerVendorWebhooks>[1]> = {}) {
  const app = Fastify();
  // Same raw-body JSON parser as index.ts — the HMAC is over the raw bytes.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  const findVendorByKey = vi.fn(async (key: string) =>
    key === 'acme' || key === 'nosecret' ? { id: `uuid-${key}`, yijiVendorId: key } : null,
  );
  const onEvent = vi.fn();
  registerVendorWebhooks(app, {
    yijiWebhookSecret: env.YIJI_WEBHOOK_SECRET,
    secrets,
    findVendorByKey,
    toleranceSec: 300,
    logger: silent,
    onEvent,
    ...over,
  });
  return { app, findVendorByKey, onEvent };
}

function signed(url: string, secret: string, body = JSON.stringify({ type: 'order.updated' })) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: 'POST' as const,
    url,
    headers: {
      'content-type': 'application/json',
      'x-yiji-timestamp': ts,
      'x-yiji-signature': `sha256=${signWebhook(secret, ts, body)}`,
    },
    payload: body,
  };
}

describe('POST /webhooks/:vendorKey', () => {
  it("accepts a request signed with THAT vendor's secret (202)", async () => {
    const { app, onEvent } = buildApp();
    const res = await app.inject(signed('/webhooks/acme', 'acme-wh'));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', event: 'order.updated' });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ vendorKey: 'acme', event: 'order.updated' }),
    );
    await app.close();
  });

  it("refuses a request signed with ANOTHER vendor's secret (401)", async () => {
    const { app, onEvent } = buildApp();
    const res = await app.inject(signed('/webhooks/acme', 'yiji-wh'));
    expect(res.statusCode).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 404 for a key that is no active vendor', async () => {
    const { app } = buildApp();
    expect((await app.inject(signed('/webhooks/ghost', 'acme-wh'))).statusCode).toBe(404);
    expect((await app.inject(signed('/webhooks/BAD_KEY', 'acme-wh'))).statusCode).toBe(404);
    await app.close();
  });

  it("refuses a vendor with no configured secret — never falls back to Yiji's (503)", async () => {
    const { app } = buildApp();
    const res = await app.inject(signed('/webhooks/nosecret', 'yiji-wh'));
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('answers 503 when the vendor lookup fails', async () => {
    const { app } = buildApp({
      findVendorByKey: async () => {
        throw new Error('directus down');
      },
    });
    expect((await app.inject(signed('/webhooks/acme', 'acme-wh'))).statusCode).toBe(503);
    await app.close();
  });
});

describe('POST /webhooks/yiji is unchanged', () => {
  it('accepts a Yiji-signed request without any vendor lookup (202)', async () => {
    const { app, findVendorByKey } = buildApp();
    const res = await app.inject(signed('/webhooks/yiji', 'yiji-wh'));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted', event: 'order.updated' });
    expect(findVendorByKey).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses another vendor's signature (401)", async () => {
    const { app } = buildApp();
    expect((await app.inject(signed('/webhooks/yiji', 'acme-wh'))).statusCode).toBe(401);
    await app.close();
  });

  it('is 503 until YIJI_WEBHOOK_SECRET is configured', async () => {
    const { app } = buildApp({ yijiWebhookSecret: '' });
    expect((await app.inject(signed('/webhooks/yiji', 'yiji-wh'))).statusCode).toBe(503);
    await app.close();
  });
});

/* ── customer JWT ───────────────────────────────────────────────── */

/** Vendor platform ids: '1' = Yiji (default), '2' = acme, '3' = configured key without secret. */
function makeVerifier() {
  const lookupKey = vi.fn(async (id: string) =>
    id === '2' ? 'acme' : id === '3' ? 'nosecret' : id === '4' ? 'yiji' : null,
  );
  const secretFor = createVendorJwtSecrets({ secrets, defaultVendorId: '1', lookupKey });
  return { verifier: createVendorVerifier(secretFor), lookupKey, secretFor };
}
const sign = (payload: Record<string, unknown>, secret: string) =>
  jwt.sign({ customer_id: 'c1', phone: '0512345678', ...payload }, secret, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });

describe('customer JWT verified with the claimed vendor’s secret', () => {
  it('keeps a legacy Yiji token (no vendor claim) working with YIJI_JWT_SECRET', async () => {
    const { verifier, lookupKey } = makeVerifier();
    const claims = await verifier.verify(sign({}, YIJI_JWT));
    expect(claims.vendor_id).toBe('1');
    expect(lookupKey).not.toHaveBeenCalled();
  });

  it('keeps a Yiji token that names vendor 1 working', async () => {
    const { verifier } = makeVerifier();
    expect((await verifier.verify(sign({ vendor_id: '1' }, YIJI_JWT))).vendor_id).toBe('1');
  });

  it("accepts vendor B's token signed with B's secret", async () => {
    const { verifier } = makeVerifier();
    expect((await verifier.verify(sign({ vendor_id: '2' }, ACME_JWT))).vendor_id).toBe('2');
  });

  it("REJECTS a token claiming vendor B but signed with Yiji's secret (isolation)", async () => {
    const { verifier } = makeVerifier();
    await expect(verifier.verify(sign({ vendor_id: '2' }, YIJI_JWT))).rejects.toThrow(
      CustomerTokenError,
    );
  });

  it("rejects a Yiji-claiming token signed with vendor B's secret", async () => {
    const { verifier } = makeVerifier();
    await expect(verifier.verify(sign({}, ACME_JWT))).rejects.toThrow(/invalid signature/);
  });

  it('refuses a vendor with no configured secret, whatever it was signed with', async () => {
    const { verifier } = makeVerifier();
    await expect(verifier.verify(sign({ vendor_id: '3' }, YIJI_JWT))).rejects.toThrow(
      /not configured/,
    );
  });

  it('refuses an unknown vendor', async () => {
    const { verifier } = makeVerifier();
    await expect(verifier.verify(sign({ vendor_id: '9' }, YIJI_JWT))).rejects.toThrow(
      CustomerTokenError,
    );
  });

  it("never hands Yiji's secret to a non-default vendor whose key is 'yiji'", async () => {
    const { secretFor } = makeVerifier();
    expect(await secretFor('4')).toBeNull();
    expect(await secretFor('1')).toBe(YIJI_JWT);
  });

  it('a cross-vendor token is refused by the full resolver too (no Yiji-id fallback)', async () => {
    const { verifier } = makeVerifier();
    const yijiUsers = vi.fn(async () => null);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    await expect(
      resolveCustomerClaims(sign({ vendor_id: '2' }, YIJI_JWT), verifier, yijiUsers, logger),
    ).rejects.toThrow(CustomerTokenError);
    expect(yijiUsers).not.toHaveBeenCalled();
  });

  it('still routes an app-issued Yiji session token to the Yiji user lookup', async () => {
    const { verifier } = makeVerifier();
    const yijiUsers = vi.fn(async () => ({
      id: 'u-1',
      phone: '+966515553891',
      name: 'N',
      email: null,
    }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const appToken = jwt.sign({ Id: 'u-1', iss: 'SecureApi' }, 'yijis-own-secret', {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    const claims = await resolveCustomerClaims(appToken, verifier, yijiUsers as never, logger);
    expect(yijiUsers).toHaveBeenCalledWith('u-1');
    expect(claims.vendor_id).toBe('1');
  });
});
