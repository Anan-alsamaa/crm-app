import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { CustomerPushJob } from '@yiji/shared-types';

/**
 * Tell a customer's PHONE that an agent replied while they were away.
 *
 * The widget already promises "we will get back to you" when nobody is online.
 * This is the other half of that promise: the reply arrives hours later, in a
 * chat the customer has closed, and the only thing that can reach them is the
 * Yiji app they already have installed. The CRM cannot raise a notification on
 * a handset — it can only ask the app to.
 *
 * Enqueued by the gateway ONLY when no customer socket is in the conversation.
 * Somebody watching the thread is already reading the message.
 *
 * Deliberately shaped like `coupon-push`, because the situation is the same:
 * the CRM half is finished and the Yiji half is a URL we do not have yet. A
 * blank `YIJI_NOTIFY_URL` disables delivery and logs the exact payload that
 * would have been sent, so the contract can be agreed against something real
 * instead of a description of it.
 */

export interface CustomerPushDeps {
  logger: Logger;
  /** Blank disables delivery — see below. */
  yijiNotifyUrl: string;
  yijiApiKey: string;
  /**
   * Yiji's `NotifTopic` for "a support agent replied".
   *
   * THIS IS THE ONE THING WE DO NOT KNOW. Yiji's real endpoint is
   * `POST /api/NotificationData/SendNotification`, and it takes NO free text:
   * the body the customer reads is rendered on their side from a template
   * chosen by this integer. The published enum is 0-38 with no names attached,
   * and none is documented as a support reply.
   *
   * So it stays unset until Yiji names it. Guessing would not fail safe — it
   * would deliver a confident, wrong notification ("your order is ready") to a
   * real customer's handset, which cannot be recalled. Silence is the better
   * of the two failures, and the log keeps the evidence either way.
   */
  yijiNotifyTopic?: number | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export type CustomerPushOutcome = 'delivered' | 'disabled' | 'unaddressable';

/**
 * What the mobile app is asked to show.
 *
 * Both identifiers travel because either may be the one the app can resolve: a
 * customer who reached us through the app has an `external_customer_id`, while
 * a walk-in from a store QR code may only ever have a phone number.
 */
export function customerPushPayload(job: CustomerPushJob): Record<string, unknown> {
  return {
    conversation_id: job.conversationId,
    customer: {
      phone: job.phone,
      external_customer_id: job.externalCustomerId,
    },
    // The app renders its own title; this is the body it shows under it.
    preview: job.preview,
    sent_at: job.sentAt,
    // A deep link target, so tapping the notification opens THIS chat rather
    // than the app's home screen.
    deep_link: `yiji://support/conversation/${job.conversationId}`,
    source: 'sara-crm',
  };
}

/**
 * The same notification in YIJI's shape, for their real endpoint.
 *
 * `POST /api/NotificationData/SendNotification` takes `SendPushNotificationsObj`:
 * `{ topic, notifParams, phoneNumber, userId, tenantId }`. Both identifiers may
 * travel — Yiji resolves the handset from whichever it can.
 *
 * NOTE WHAT IS MISSING: there is nowhere to put `preview`. `NotifParams` holds
 * order ids, coupon codes and OTPs, not prose, so the agent's actual words
 * cannot cross this boundary. The customer gets a templated nudge that support
 * replied, and reads the reply by opening the chat. That is a limitation of
 * their contract, not a shortcut taken here — and it is worth confirming with
 * Yiji whether a free-text topic exists before settling for it.
 */
export function yijiNotifyPayload(job: CustomerPushJob, topic: number, tenantId = 0) {
  return {
    topic,
    notifParams: {
      // The deep link target, in the one field their schema leaves general
      // enough to carry it. Confirm against their template before enabling.
      orderId: job.conversationId,
    },
    phoneNumber: job.phone,
    userId: job.externalCustomerId,
    tenantId,
  };
}

export async function processCustomerPushJob(
  job: Job<CustomerPushJob>,
  deps: CustomerPushDeps,
): Promise<CustomerPushOutcome> {
  const { logger, yijiNotifyUrl, yijiApiKey } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const data = job.data;

  /*
   * Nothing to address it to. A contact with neither a phone nor a Yiji id
   * cannot be reached by any notification channel, and retrying will not
   * conjure one — so this is a clean stop rather than a thrown error that
   * BullMQ would back off and retry five times.
   */
  if (!data.phone && !data.externalCustomerId) {
    logger.warn(
      { conversationId: data.conversationId },
      'customer push skipped — contact has no phone or Yiji id',
    );
    return 'unaddressable';
  }

  const payload = customerPushPayload(data);

  /*
   * No endpoint configured means no delivery, and it is logged rather than
   * silently dropped. The payload goes into the log on purpose: it is the
   * concrete thing to hand the mobile developer when agreeing the contract.
   */
  if (!yijiNotifyUrl.trim()) {
    logger.info(
      { conversationId: data.conversationId, payload },
      'YIJI_NOTIFY_URL not set — customer push is disabled, nothing sent',
    );
    return 'disabled';
  }

  /*
   * Yiji's own endpoint needs their shape AND a topic. Detected from the URL so
   * that a generic webhook (a relay, a test collector) still receives the
   * self-describing payload above.
   */
  const isYijiEndpoint = /\/api\/NotificationData\/SendNotification\b/i.test(yijiNotifyUrl);
  const topic = deps.yijiNotifyTopic;

  if (isYijiEndpoint && (topic === undefined || topic === null)) {
    /*
     * Configured to call Yiji, but nobody has said which template to use. The
     * honest outcome is to send nothing: their API would render SOME other
     * notification's text at a real customer, and a wrong push cannot be
     * unsent. Not thrown — a retry would not discover the topic either.
     */
    logger.warn(
      { conversationId: data.conversationId, payload },
      'YIJI_NOTIFY_TOPIC not set — refusing to send an untyped push to Yiji, nothing sent',
    );
    return 'disabled';
  }

  const body = isYijiEndpoint ? yijiNotifyPayload(data, topic as number) : payload;

  const res = await doFetch(yijiNotifyUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(yijiApiKey ? { authorization: `Bearer ${yijiApiKey}` } : {}),
      // Same key across retries of one send, so a timeout that actually
      // succeeded cannot buzz the customer's phone twice.
      'idempotency-key': `${data.conversationId}:${data.sentAt}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Thrown so BullMQ retries with backoff. A reply the customer never hears
    // about is the whole failure this job exists to prevent.
    throw new Error(`yiji notify failed (${res.status}): ${body.slice(0, 300)}`);
  }

  logger.info({ conversationId: data.conversationId }, 'customer push delivered to Yiji');
  return 'delivered';
}
