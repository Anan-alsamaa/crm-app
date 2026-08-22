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

  const res = await doFetch(yijiNotifyUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(yijiApiKey ? { authorization: `Bearer ${yijiApiKey}` } : {}),
      // Same key across retries of one send, so a timeout that actually
      // succeeded cannot buzz the customer's phone twice.
      'idempotency-key': `${data.conversationId}:${data.sentAt}`,
    },
    body: JSON.stringify(payload),
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
