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

/**
 * Sending through YIJI'S OWN endpoint.
 *
 * `POST /api/NotificationData/SendNotification` was found in their published
 * Swagger after the ops manager reported that a reply sent while the customer
 * was away never reached them. It takes `{ topic, notifParams, phoneNumber,
 * userId, tenantId }` — and critically NO free-text field: the words the
 * customer reads come from a template on Yiji's side, selected by `topic`.
 *
 * The enum is 0-38 with no names published, and none is documented as "support
 * agent replied". So the send is gated on someone at Yiji naming it. A wrong
 * topic does not fail quietly — it delivers a confident, unrelated notification
 * ("your order is ready") to a real customer, and cannot be recalled.
 */
describe('delivering through Yiji', () => {
  const YIJI = 'https://admin.yiji-app.com/api/NotificationData/SendNotification';

  it('REFUSES to send to Yiji with no topic, rather than guessing one', async () => {
    const fetchImpl = vi.fn();
    const out = await processCustomerPushJob(job(), {
      logger,
      yijiNotifyUrl: YIJI,
      yijiApiKey: 'k',
      yijiNotifyTopic: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe('disabled');
    // The decisive assertion: nothing left the building.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends YIJI's shape once the topic is known", async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const out = await processCustomerPushJob(job(), {
      logger,
      yijiNotifyUrl: YIJI,
      yijiApiKey: 'k',
      yijiNotifyTopic: 12,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe('delivered');
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.topic).toBe(12);
    // Both identifiers travel: Yiji resolves the handset from whichever it can.
    expect(body.phoneNumber).toBe('+966555123456');
    expect(body.userId).toBe('cust-966555123456');
  });

  it('still sends the self-describing payload to a NON-Yiji endpoint', async () => {
    // A relay or test collector gets the full shape, preview and all — the
    // topic requirement is Yiji's constraint, not ours.
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await processCustomerPushJob(job(), {
      logger,
      yijiNotifyUrl: 'https://relay.example.com/hook',
      yijiApiKey: '',
      yijiNotifyTopic: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.preview).toContain('refunded');
    expect(body.deep_link).toBe('yiji://support/conversation/conv-1');
  });
});
