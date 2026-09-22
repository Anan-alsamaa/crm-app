import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { CustomerPushJob } from '@yiji/shared-types';
import {
  yijiCrmNotifyPayload,
  crmChatLink,
  brandIdForOrder,
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
      brandId: 1,
      title: 'Yiji Support',
      openChatAction: 'crm.openchat',
    });
    expect(p.body).toBe('Sorry about that — we have refunded your order.');
    expect(p.title).toBe('Yiji Support');
  });

  /*
   * THE CUSTOMER HAS NEVER HEARD OF SARA. It is what we call this CRM
   * internally; the notification arrives in the Yiji app, from the company
   * they complained to. A name they do not recognise on a lock screen reads
   * as a stranger, or as phishing (owner, 2026-09-21).
   */
  it('defaults the heading to the name the customer knows', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as never);
    await processCustomerPushJob({ data: job() } as Job<CustomerPushJob>, {
      logger,
      yijiNotifyUrl: CRM_URL,
      yijiApiKey: 'k',
      fetchImpl: fetchImpl as never,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    const sent = JSON.parse(init.body) as Record<string, unknown>;
    expect(sent.title).toBe('Yiji Support');
    expect(String(sent.title)).not.toMatch(/sara/i);
  });

  it('addresses the customer by their Yiji id and phone, on tenant 1', () => {
    const p = yijiCrmNotifyPayload(job(), {
      tenantId: 1,
      brandId: 1,
      title: 'T',
      openChatAction: 'crm.openchat',
    });
    expect(p.userId).toBe('yiji-user-9');
    // Converted to the only form Yiji resolves — see 'what Yiji actually requires'.
    expect(p.phoneNumber).toBe('+966512345678');
    expect(p.tenantId).toBe(1);
  });

  /* Optional per Yiji, and most support chats have no order. Omitted rather
     than sent empty: a blank id is a value, and absence is the truth. */
  it('omits orderId entirely', () => {
    const p = yijiCrmNotifyPayload(job(), {
      tenantId: 1,
      brandId: 1,
      title: 'T',
      openChatAction: 'crm.openchat',
    });
    expect('orderId' in p).toBe(false);
  });

  /* The tap has to land in the CRM chat the agent replied in — opened from
     inside the Yiji app, not on Yiji's home screen. */
  it('sends the prop1 ACTION, not a web link', () => {
    const p = yijiCrmNotifyPayload(job(), {
      tenantId: 1,
      brandId: 1,
      title: 'T',
      openChatAction: 'crm.openchat',
    });
    const data = p.data as Record<string, unknown>;
    expect(data.prop1).toBe('crm.openchat');
    /*
     * The web keys are GONE. They carried `https://crm.anan.sa/?…`, so a tap
     * opened a browser instead of the app — the reported bug. `prop1` is the
     * one key Yiji carries through, and it names an action the app matches on.
     */
    expect(data.url).toBeUndefined();
    expect(data.deepLink).toBeUndefined();
  });

  /* Carried for OUR log correlation only. The app has never seen this id and
     cannot resolve it; it finds the chat from who the customer is. */
  it('still carries our conversation id, for correlation', () => {
    const p = yijiCrmNotifyPayload(job(), {
      tenantId: 1,
      brandId: 1,
      title: 'T',
      openChatAction: 'crm.openchat',
    });
    expect((p.data as Record<string, unknown>).conversationId).toBe('conv-123');
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
  /*
   * YIJI DECIDES WHO HAS THE APP, NOT US. Their endpoint resolves the customer
   * from the phone and answers "Customer not found." when there is no account
   * (measured, 2026-09-21) — so a walk-in who happens to have the app
   * installed is worth trying, and refusing would deny them a notification
   * they could perfectly well receive.
   */
  it('still tries for a walk-in who has only a phone', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as never);
    const out = await processCustomerPushJob(
      { data: job({ externalCustomerId: null }) } as Job<CustomerPushJob>,
      { logger, yijiNotifyUrl: CRM_URL, yijiApiKey: 'k', fetchImpl: fetchImpl as never },
    );
    expect(out).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalled();
  });

  /* Neither identifier is hopeless, and no backoff conjures a phone number. */
  it('stops cleanly when there is nothing to address it to', async () => {
    const fetchImpl = vi.fn();
    const out = await processCustomerPushJob(
      { data: job({ externalCustomerId: null, phone: null }) } as Job<CustomerPushJob>,
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

describe('how it authenticates', () => {
  /*
   * THE SAME CREDENTIAL AS THE COUPON PUSH. Yiji's notification host accepts
   * the admin API's login, so this reuses the poster that signs in, caches the
   * token in memory and re-signs when it expires. A bearer token pasted into
   * an env file has no rotation and no owner, and when it lapses the failure
   * is silence (owner, 2026-09-21).
   */
  it('sends through the signed poster rather than a pasted token', async () => {
    const postNotification = vi.fn(async () => ({}) as never);
    const fetchImpl = vi.fn();
    const out = await processCustomerPushJob({ data: job() } as Job<CustomerPushJob>, {
      logger,
      yijiNotifyUrl: CRM_URL,
      yijiApiKey: '',
      postNotification,
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBe('delivered');
    expect(fetchImpl).not.toHaveBeenCalled();
    const [url, body] = postNotification.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe(CRM_URL);
    expect(body.tenantId).toBe(1);
  });

  /* A refusal must reach BullMQ so it retries with backoff — a reply the
     customer never hears about is the failure this job exists to prevent. */
  it('lets a refusal propagate so the job is retried', async () => {
    const postNotification = vi.fn(async () => {
      throw new Error('yiji said no');
    });
    await expect(
      processCustomerPushJob({ data: job() } as Job<CustomerPushJob>, {
        logger,
        yijiNotifyUrl: CRM_URL,
        yijiApiKey: '',
        postNotification: postNotification as never,
      }),
    ).rejects.toThrow('yiji said no');
  });
});

/*
 * MEASURED AGAINST YIJI'S LIVE ENDPOINT (2026-09-21), not assumed. Each of
 * these was a distinct refusal until the request was shaped this way.
 */
describe('what Yiji actually requires', () => {
  it('sends the phone as +9665…, which is the only form they resolve', () => {
    const p = yijiCrmNotifyPayload(job({ phone: '0565266122' }), {
      tenantId: 1,
      brandId: 1,
      title: 'T',
      openChatAction: 'crm.openchat',
    });
    // `05…` is answered with "Customer not found."
    expect(p.phoneNumber).toBe('+966565266122');
  });

  it('always sends brandId — the Firebase credential is resolved from it', () => {
    const p = yijiCrmNotifyPayload(job(), {
      tenantId: 1,
      brandId: 3,
      title: 'T',
      openChatAction: 'crm.openchat',
    });
    // Omitting it: "BrandId is required to resolve the Firebase credential."
    expect(p.brandId).toBe(3);
  });

  it('passes a non-Saudi number through rather than dropping it', () => {
    const p = yijiCrmNotifyPayload(job({ phone: '+441234567890' }), {
      tenantId: 1,
      brandId: 1,
      title: 'T',
      openChatAction: 'crm.openchat',
    });
    expect(p.phoneNumber).toBe('+441234567890');
  });
});

/*
 * THE BRAND COMES FROM THE CUSTOMER'S LATEST ORDER (owner, 2026-09-21).
 *
 * Yiji resolves the Firebase credential from `brandId`, and their order data
 * carries the brand only as TEXT — so the name is mapped to an id here. Sent
 * under the wrong brand a notification still arrives; not sent at all, the
 * customer hears nothing. Everything therefore falls back rather than fails.
 */
describe('brandIdForOrder', () => {
  it.each([
    ['La Casa Pasta', 1],
    ['Okashi', 3],
    ['Chick n Dip', 81],
    ['Poshak', 1004],
  ])('maps %s to %i', (name, id) => {
    expect(brandIdForOrder(name).brandId).toBe(id);
  });

  /* A brand name is typed by people: a stray space or a lowercase article
     must not silently send an Okashi customer the Casa Pasta credential. */
  it.each(['  la  casa pasta ', 'LA CASA PASTA', 'Casa Pasta'])(
    'matches %p despite spacing and case',
    (name) => {
      expect(brandIdForOrder(name).brandId).toBe(1);
    },
  );

  it('falls back when there is no order to read a brand from', () => {
    expect(brandIdForOrder(null)).toEqual({ brandId: 1, matched: false });
    expect(brandIdForOrder('')).toEqual({ brandId: 1, matched: false });
  });

  /* An unmapped brand is reported, not swallowed — otherwise a new brand
     disappears into the default for ever and nobody knows to add it. */
  it('reports an unmapped brand rather than pretending it matched', () => {
    expect(brandIdForOrder('Some New Brand')).toEqual({ brandId: 1, matched: false });
  });
});

describe('choosing the brand at send time', () => {
  it('uses the brand of the latest order', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as never);
    await processCustomerPushJob({ data: job() } as Job<CustomerPushJob>, {
      logger,
      yijiNotifyUrl: CRM_URL,
      yijiApiKey: 'k',
      latestBrandName: async () => 'Okashi',
      fetchImpl: fetchImpl as never,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect((JSON.parse(init.body) as Record<string, unknown>).brandId).toBe(3);
  });

  /* An order lookup that fails must not cost the customer their notification. */
  it('falls back to 1 when the order lookup throws', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as never);
    await processCustomerPushJob({ data: job() } as Job<CustomerPushJob>, {
      logger,
      yijiNotifyUrl: CRM_URL,
      yijiApiKey: 'k',
      latestBrandName: async () => {
        throw new Error('yiji down');
      },
      fetchImpl: fetchImpl as never,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect((JSON.parse(init.body) as Record<string, unknown>).brandId).toBe(1);
  });
});

describe('yijiCrmNotifyPayload — the STAGING push redirect', () => {
  /*
   * Staging shares Yiji's PRODUCTION notification service. Without this,
   * testing rings a real stranger's phone with an agent's words.
   */
  const base = {
    tenantId: 1,
    brandId: 1,
    title: 'Yiji Support',
    openChatAction: 'crm.openchat',
  };

  it('rings the real customer when no redirect is configured', () => {
    const p = yijiCrmNotifyPayload(job(), base);
    expect(p.phoneNumber).toBe('+966512345678');
    expect(p.userId).toBe('yiji-user-9');
  });

  it('rings the test handset when one is configured', () => {
    const p = yijiCrmNotifyPayload(job(), { ...base, phoneOverride: '+966565266122' });
    expect(p.phoneNumber).toBe('+966565266122');
  });

  /*
   * Yiji resolves the recipient from whichever identifier it trusts, so a
   * payload naming the test PHONE and the real customer's id is a coin toss
   * that can still reach the stranger. The id goes with the phone.
   */
  it('drops the real Yiji user id, so the pair cannot name two people', () => {
    const p = yijiCrmNotifyPayload(job(), { ...base, phoneOverride: '+966565266122' });
    expect(p.userId).toBeUndefined();
  });
});
