import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { CustomerPushJob } from '@yiji/shared-types';
import { customerPushPayload, processCustomerPushJob } from '../src/processors/customer-push.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof processCustomerPushJob>[1]['logger'];

const job = (over: Partial<CustomerPushJob> = {}): Job<CustomerPushJob> =>
  ({
    data: {
      conversationId: 'conv-1',
      phone: '+966555123456',
      externalCustomerId: 'cust-966555123456',
      preview: 'Sorry about that — we have refunded the item.',
      sentAt: '2026-08-22T10:00:00.000Z',
      ...over,
    },
  }) as Job<CustomerPushJob>;

describe('customerPushPayload', () => {
  it('carries BOTH identifiers, because either may be the resolvable one', () => {
    // An in-app customer has a Yiji id; a walk-in from a store QR code may
    // only ever have a phone number.
    const p = customerPushPayload(job().data);
    expect(p.customer).toEqual({
      phone: '+966555123456',
      external_customer_id: 'cust-966555123456',
    });
  });

  it('deep-links to the conversation, not the app home screen', () => {
    expect(customerPushPayload(job().data).deep_link).toBe('yiji://support/conversation/conv-1');
  });
});

describe('processCustomerPushJob', () => {
  it('sends nothing and says so when no endpoint is configured', async () => {
    const fetchImpl = vi.fn();
    const out = await processCustomerPushJob(job(), {
      logger,
      yijiNotifyUrl: '',
      yijiApiKey: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops cleanly when the contact cannot be addressed at all', async () => {
    // Retrying will not conjure a phone number, so this must not throw and
    // send BullMQ into five backed-off attempts.
    const fetchImpl = vi.fn();
    const out = await processCustomerPushJob(job({ phone: null, externalCustomerId: null }), {
      logger,
      yijiNotifyUrl: 'https://yiji.example/notify',
      yijiApiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe('unaddressable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the payload with an idempotency key tied to the exact send', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    const out = await processCustomerPushJob(job(), {
      logger,
      yijiNotifyUrl: 'https://yiji.example/notify',
      yijiApiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe('delivered');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://yiji.example/notify');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer secret');
    // A timeout that actually succeeded must not buzz the phone twice.
    expect(headers['idempotency-key']).toBe('conv-1:2026-08-22T10:00:00.000Z');
  });

  it('throws on an upstream failure so the job retries', async () => {
    // A reply the customer never hears about is the failure this job exists
    // to prevent — swallowing it would defeat the point.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 502, text: async () => 'bad' });
    await expect(
      processCustomerPushJob(job(), {
        logger,
        yijiNotifyUrl: 'https://yiji.example/notify',
        yijiApiKey: '',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/502/);
  });
});
