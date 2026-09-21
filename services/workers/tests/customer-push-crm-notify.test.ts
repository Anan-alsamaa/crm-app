import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { CustomerPushJob } from '@yiji/shared-types';
import {
  yijiCrmNotifyPayload,
  crmChatLink,
  processCustomerPushJob,
} from '../src/processors/customer-push.js';

/*
 * YIJI'S CRM ENDPOINT — the one that can carry what the agent actually said.
 *
 * `SendCrmNotification` takes free-text `title` and `body`, which the older
 * `SendNotification` could not: that one renders from a numbered template, so
 * the reply never crossed the boundary and the path stayed disabled rather
 * than guessing a topic and pushing "your order is ready" at a real customer.
 */
const CRM_URL = 'https://notificationsystems.yiji-app.com/api/NotificationData/SendCrmNotification';

const job = (over: Partial<CustomerPushJob> = {}): CustomerPushJob => ({
  conversationId: 'conv-123',
  phone: '0512345678',
  externalCustomerId: 'yiji-user-9',
  preview: 'Sorry about that — we have refunded your order.',
  sentAt: '2026-09-21T10:00:00.000Z',
  ...over,
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('yijiCrmNotifyPayload', () => {
  it('sends the agent’s own words as the body', () => {
    const p = yijiCrmNotifyPayload(job(), {
      tenantId: 1,
      title: 'Sara Support',
      chatUrl: 'https://crm.anan.sa/?conversation=conv-123',
    });
    expect(p.body).toBe('Sorry about that — we have refunded your order.');
    expect(p.title).toBe('Sara Support');
  });

  it('addresses the customer by their Yiji id and phone, on tenant 1', () => {
    const p = yijiCrmNotifyPayload(job(), { tenantId: 1, title: 'T', chatUrl: 'u' });
    expect(p.userId).toBe('yiji-user-9');
    expect(p.phoneNumber).toBe('0512345678');
    expect(p.tenantId).toBe(1);
  });

  /* Optional per Yiji, and most support chats have no order. Omitted rather
     than sent empty: a blank id is a value, and absence is the truth. */
  it('omits orderId entirely', () => {
    const p = yijiCrmNotifyPayload(job(), { tenantId: 1, title: 'T', chatUrl: 'u' });
    expect('orderId' in p).toBe(false);
  });

  /* The tap has to land in the CRM chat the agent replied in — opened from
     inside the Yiji app, not on Yiji's home screen. */
  it('carries the chat link so the tap opens THAT conversation', () => {
    const p = yijiCrmNotifyPayload(job(), {
      tenantId: 1,
      title: 'T',
      chatUrl: 'https://crm.anan.sa/?conversation=conv-123',
    });
    const data = p.data as Record<string, unknown>;
    expect(data.url).toBe('https://crm.anan.sa/?conversation=conv-123');
    expect(data.conversationId).toBe('conv-123');
  });
});

describe('crmChatLink', () => {
  it('names the conversation', () => {
    expect(crmChatLink('https://crm.anan.sa', 'abc')).toBe('https://crm.anan.sa/?conversation=abc');
  });

  it('tolerates a trailing slash on the configured origin', () => {
    expect(crmChatLink('https://crm.anan.sa/', 'abc')).toBe(
      'https://crm.anan.sa/?conversation=abc',
    );
  });

  /* A notification is not a safe place for a credential, and one minted now
     would be expired by the time somebody taps it tomorrow. */
  it('carries no token', () => {
    const link = crmChatLink('https://crm.anan.sa', 'abc');
    expect(link).not.toMatch(/token|jwt|eyJ/i);
  });
});

describe('who can be notified', () => {
  /* A push is delivered through the Yiji app, so it can only reach somebody
     who has an account. A QR walk-in has a phone and nothing else. */
  it('skips a walk-in with no Yiji account, without retrying', async () => {
    const fetchImpl = vi.fn();
    const out = await processCustomerPushJob(
      { data: job({ externalCustomerId: null }) } as Job<CustomerPushJob>,
      { logger, yijiNotifyUrl: CRM_URL, yijiApiKey: 'k', fetchImpl: fetchImpl as never },
    );
    expect(out).toBe('unaddressable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends for a customer who holds a Yiji account', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as never);
    const out = await processCustomerPushJob({ data: job() } as Job<CustomerPushJob>, {
      logger,
      yijiNotifyUrl: CRM_URL,
      yijiApiKey: 'k',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBe('delivered');
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(CRM_URL);
    const sent = JSON.parse(init.body) as Record<string, unknown>;
    expect(sent.tenantId).toBe(1);
    expect(sent.body).toContain('refunded');
  });
});
