import { describe, it, expect } from 'vitest';
import { verifyWebhookSignature, signWebhook } from '../src/webhook.js';

const SECRET = 'whsec_test_0123456789abcdef';
const BODY = JSON.stringify({ type: 'order.updated', id: 'ord_1' });
const NOW_MS = 1_700_000_000_000;
const TS = String(Math.floor(NOW_MS / 1000));

const sign = (ts: string, body: string) => `sha256=${signWebhook(SECRET, ts, body)}`;

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed, fresh request', () => {
    const r = verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signature: sign(TS, BODY),
      timestamp: TS,
      toleranceSec: 300,
      nowMs: NOW_MS,
    });
    expect(r.valid).toBe(true);
  });

  it('accepts a bare hex signature without the sha256= scheme', () => {
    const r = verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signature: signWebhook(SECRET, TS, BODY),
      timestamp: TS,
      toleranceSec: 300,
      nowMs: NOW_MS,
    });
    expect(r.valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const r = verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY + ' ',
      signature: sign(TS, BODY),
      timestamp: TS,
      toleranceSec: 300,
      nowMs: NOW_MS,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/mismatch/);
  });

  it('rejects a wrong secret', () => {
    const r = verifyWebhookSignature({
      secret: 'other-secret',
      rawBody: BODY,
      signature: sign(TS, BODY),
      timestamp: TS,
      toleranceSec: 300,
      nowMs: NOW_MS,
    });
    expect(r.valid).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    const r = verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signature: sign(TS, BODY),
      timestamp: TS,
      toleranceSec: 300,
      nowMs: NOW_MS + 301_000,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/tolerance|replay/);
  });

  it('rejects when the secret is not configured', () => {
    const r = verifyWebhookSignature({
      secret: '',
      rawBody: BODY,
      signature: sign(TS, BODY),
      timestamp: TS,
      toleranceSec: 300,
      nowMs: NOW_MS,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not configured/);
  });

  it('rejects missing signature / timestamp headers', () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signature: undefined,
        timestamp: TS,
        toleranceSec: 300,
        nowMs: NOW_MS,
      }).valid,
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signature: sign(TS, BODY),
        timestamp: undefined,
        toleranceSec: 300,
        nowMs: NOW_MS,
      }).valid,
    ).toBe(false);
  });

  it('rejects a malformed (non-hex) signature without throwing', () => {
    const r = verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signature: 'sha256=not-hex-zzzz',
      timestamp: TS,
      toleranceSec: 300,
      nowMs: NOW_MS,
    });
    expect(r.valid).toBe(false);
  });
});
