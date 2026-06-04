import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inbound webhook signature verification (spec §17 "secure webhook handling",
 * FR-034). HMAC-SHA256 over `${timestamp}.${rawBody}`, compared timing-safely,
 * with a timestamp tolerance window to reject replays.
 *
 * The sender (e.g. the Yiji platform) must send:
 *   X-Yiji-Timestamp: <unix seconds>
 *   X-Yiji-Signature: sha256=<hex hmac of "<timestamp>.<raw body>">
 *
 * `nowMs` is injectable so the tolerance window is testable.
 */
export interface WebhookVerifyInput {
  secret: string;
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  toleranceSec: number;
  nowMs?: number;
}

export interface WebhookVerifyResult {
  valid: boolean;
  reason?: string;
}

const stripScheme = (s: string): string =>
  s.startsWith('sha256=') ? s.slice('sha256='.length) : s;

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyWebhookSignature(input: WebhookVerifyInput): WebhookVerifyResult {
  const { secret, rawBody, signature, timestamp, toleranceSec } = input;
  if (!secret) return { valid: false, reason: 'webhook secret not configured' };
  if (!signature) return { valid: false, reason: 'missing signature header' };
  if (!timestamp) return { valid: false, reason: 'missing timestamp header' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { valid: false, reason: 'invalid timestamp' };
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > toleranceSec) {
    return { valid: false, reason: 'timestamp outside tolerance window (possible replay)' };
  }

  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), 'hex');
  let provided: Buffer;
  try {
    provided = Buffer.from(stripScheme(signature.trim()), 'hex');
  } catch {
    return { valid: false, reason: 'malformed signature encoding' };
  }
  // timingSafeEqual throws on length mismatch, so length-check first (the
  // length itself is not secret) before the constant-time comparison.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}
