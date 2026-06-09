import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { verifyWebhookSignature, signWebhook } from '../src/webhook.js';

/**
 * Guards the gateway's webhook wiring as built in index.ts: replacing the
 * default JSON parser must NOT throw (a duplicate addContentTypeParser would
 * crash boot — FST_ERR_CTP_ALREADY_PRESENT), the raw body must be retained for
 * HMAC, and the route must gate on a valid signature.
 */
function buildApp(secret: string) {
  const app = Fastify();
  // Same pattern as index.ts.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.post('/webhooks/yiji', async (req, reply) => {
    if (!secret) return reply.code(503).send({ status: 'webhooks-not-configured' });
    const result = verifyWebhookSignature({
      secret,
      rawBody: (req as { rawBody?: string }).rawBody ?? '',
      signature: req.headers['x-yiji-signature'] as string | undefined,
      timestamp: req.headers['x-yiji-timestamp'] as string | undefined,
      toleranceSec: 300,
    });
    if (!result.valid) return reply.code(401).send({ status: 'invalid-signature' });
    return reply.code(202).send({ status: 'accepted' });
  });
  return app;
}

describe('webhook route wiring (boot + behaviour)', () => {
  it('builds without throwing (no duplicate-parser crash)', async () => {
    const app = buildApp('');
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it('returns 503 when no secret configured', async () => {
    const app = buildApp('');
    const res = await app.inject({ method: 'POST', url: '/webhooks/yiji', payload: { a: 1 } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('rejects an unsigned request with 401', async () => {
    const app = buildApp('whsec');
    const res = await app.inject({ method: 'POST', url: '/webhooks/yiji', payload: { a: 1 } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a correctly signed request with 202 (raw body preserved)', async () => {
    const app = buildApp('whsec');
    const body = JSON.stringify({ type: 'order.updated' });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/yiji',
      headers: {
        'content-type': 'application/json',
        'x-yiji-timestamp': ts,
        'x-yiji-signature': `sha256=${signWebhook('whsec', ts, body)}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});
