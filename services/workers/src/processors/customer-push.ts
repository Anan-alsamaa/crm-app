import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { CustomerPushJob } from '@yiji/shared-types';
import { internationalPhone } from '@yiji/shared-types';

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
  /**
   * Yiji's tenant, for `SendCrmNotification`. 1 for Yiji (owner, 2026-09-21).
   * Configurable rather than hardcoded so a second platform is a setting.
   */
  yijiTenantId?: number;
  /**
   * Which BRAND the push is sent as — Yiji picks the Firebase credential from
   * it, so their API refuses the request without one.
   *
   * A single default rather than per-ticket for now: a chat has no brand until
   * a ticket exists, and most support replies happen before one is raised.
   * Casa Pasta is 1, Okashi 3, Chick n Dip 81, Poshak 1004 (owner,
   * 2026-09-21) — so resolving it from the ticket's brand is the improvement
   * to make once the basic path is proven.
   */
  yijiBrandId?: number;
  /**
   * The notification's HEADING, as the CUSTOMER reads it.
   *
   * `Yiji Support`, not `Sara Support`: Sara is what WE call this CRM, and the
   * customer has never heard of it (owner, 2026-09-21). The notification
   * arrives in the Yiji app, from the company they complained to — a name they
   * do not recognise on their lock screen reads as a stranger, or as a
   * phishing attempt.
   *
   * The agent's own words go in the body, so this only has to say who is
   * speaking.
   */
  yijiNotifyTitle?: string;
  /**
   * The CRM chat's public origin — where tapping the notification lands.
   *
   * The conversation is named in the URL, so the customer opens the chat they
   * were already having rather than the app's home screen.
   */
  crmChatUrl?: string;
  /**
   * Sends the notification signed in as the CRM service user.
   *
   * THE SAME POSTER THE COUPON PUSH USES (owner, 2026-09-21). It signs in
   * with the service credential, caches the token in memory and re-signs when
   * it expires — so there is no long-lived bearer token in an env file to
   * rotate, and nothing goes silent when one lapses.
   *
   * Absent means delivery is not configured: the payload is logged and the
   * job reports `disabled` rather than pretending it was sent.
   */
  postNotification?: (
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<unknown>;
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
/**
 * YIJI'S CRM ENDPOINT — the one that can carry what the agent actually said.
 *
 * `POST /api/NotificationData/SendCrmNotification` takes `title` and `body` as
 * free text, which is the thing `SendNotification` could not do: that endpoint
 * renders from a numbered template, so the reply itself never crossed the
 * boundary and the customer got a generic nudge. This is why the older path
 * stayed disabled rather than guessing a topic number.
 *
 * NOT SENT TO WALK-INS. A push is delivered through the Yiji app, so it can
 * only reach somebody who has it — an `externalCustomerId` is the proof of
 * that, and the caller checks for one before enqueuing (owner, 2026-09-21).
 * A QR visitor with a phone and no account is unreachable by this channel and
 * is not a failure to retry.
 *
 * `orderId` is omitted: optional per Yiji, and most support chats have no
 * order. `tenantId` is 1 for Yiji.
 *
 * `data` CARRIES THE LINK THE APP OPENS. The customer taps the notification
 * inside the Yiji app and lands in the CRM chat they were already having —
 * the same web view the app opens today — rather than on Yiji's home screen
 * (owner, 2026-09-21). Yiji said the field is optional, which is about their
 * side not requiring it; we need it, so it travels.
 *
 * An https URL, not a `yiji://` scheme: the chat IS a web page we serve, and
 * the app already knows how to open it — that is how a session starts. So the
 * tap reuses the path that exists instead of asking them to register anything.
 *
 * WHAT THE APP STILL HAS TO DO. This URL names the conversation; it carries no
 * token, because a notification is not a safe place to put one. The app mints
 * a session the way it already does (`POST /chat/session`) and opens the chat
 * with `?c=` — so the tap-through needs one small change on their side, and
 * the key they read from `data` needs confirming.
 */
/**
 * Where tapping the notification lands: the CRM chat, opened from inside the
 * Yiji app.
 *
 * Names the conversation and nothing else. It carries NO token — a
 * notification is not a safe place to put one, and one minted now would be
 * expired by the time a customer taps it tomorrow. The app opens this URL the
 * way it already opens the chat.
 *
 * A trailing slash on the configured origin is stripped, because
 * `https://crm.anan.sa//?conversation=…` is a different URL to some routers
 * and a broken-looking one to everybody.
 */
export function crmChatLink(origin: string | undefined, conversationId: string): string {
  const base = (origin ?? 'https://crm.anan.sa').replace(/\/+$/, '');
  return `${base}/?conversation=${encodeURIComponent(conversationId)}`;
}

export function yijiCrmNotifyPayload(
  job: CustomerPushJob,
  opts: { tenantId: number; brandId: number; title: string; chatUrl: string },
): Record<string, unknown> {
  return {
    userId: job.externalCustomerId,
    /*
     * `+9665XXXXXXXX`, NOT the `05…` we store.
     *
     * Yiji resolves the customer from this number and answers "Customer not
     * found." for the local form — measured against their live endpoint, not
     * assumed. The CRM stores one canonical shape and converts at the single
     * point of use, which is here.
     */
    phoneNumber: internationalPhone(job.phone) ?? job.phone,
    tenantId: opts.tenantId,
    /*
     * REQUIRED, not optional. Without it their API answers "BrandId is
     * required to resolve the Firebase credential" — the brand chooses which
     * push credential sends the message, so there is no sensible default that
     * is merely cosmetic.
     */
    brandId: opts.brandId,
    title: opts.title,
    /* The agent's own words. Trimmed by the producer to a preview length; sent
       as-is here so the customer reads a real sentence rather than a template. */
    body: job.preview,
    /* Where the tap should land. `url` and `deepLink` carry the same value
       because the key their app reads is not yet confirmed — one of the two
       will be the one it honours, and a duplicated string costs nothing. */
    data: {
      conversationId: job.conversationId,
      url: opts.chatUrl,
      deepLink: opts.chatUrl,
      source: 'sara-crm',
    },
  };
}

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
  /* Their CRM endpoint, which carries free text. Tested FIRST and the older
     check excludes it, so a URL cannot match both. */
  const isYijiCrmEndpoint = /\/api\/NotificationData\/SendCrmNotification\b/i.test(yijiNotifyUrl);
  const isYijiEndpoint =
    !isYijiCrmEndpoint && /\/api\/NotificationData\/SendNotification\b/i.test(yijiNotifyUrl);
  const topic = deps.yijiNotifyTopic;

  /*
   * A PUSH CAN ONLY REACH SOMEBODY WHO HAS THE APP — and YIJI decides who that
   * is, not us.
   *
   * Their endpoint resolves the customer from the PHONE NUMBER and answers
   * "Customer not found." when no account exists (measured, 2026-09-21). So a
   * phone alone is worth trying: a visitor who scanned a branch QR code may
   * well have the app installed, and refusing to try would deny them a
   * notification they could perfectly well receive.
   *
   * Only a contact with NEITHER identifier is hopeless, and that is a clean
   * stop rather than a retry — no amount of backoff conjures a phone number.
   */
  if (isYijiCrmEndpoint && !data.externalCustomerId && !data.phone) {
    logger.info(
      { conversationId: data.conversationId },
      'customer push skipped - neither a Yiji id nor a phone to address it to',
    );
    return 'unaddressable';
  }

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

  const body = isYijiCrmEndpoint
    ? yijiCrmNotifyPayload(data, {
        tenantId: deps.yijiTenantId ?? 1,
        brandId: deps.yijiBrandId ?? 1,
        title: deps.yijiNotifyTitle ?? 'Yiji Support',
        chatUrl: crmChatLink(deps.crmChatUrl, data.conversationId),
      })
    : isYijiEndpoint
      ? yijiNotifyPayload(data, topic as number)
      : payload;

  /* Same key across retries of one send, so a timeout that in fact succeeded
     cannot buzz the customer's phone twice. */
  const idempotencyKey = `${data.conversationId}:${data.sentAt}`;

  /*
   * SIGNED IN AS THE SERVICE, NOT CARRYING A PASTED TOKEN.
   *
   * Yiji's notification host accepts the same credential as their admin API,
   * so this reuses the poster the coupon push already uses: it signs in,
   * caches the token in memory and re-signs when it expires. A bearer token in
   * an env file has no rotation and no owner, and when it lapses the failure
   * is silence (owner, 2026-09-21).
   *
   * `postNotification` throws on refusal, which is what BullMQ needs to retry
   * — the same contract as the direct fetch below.
   */
  if (isYijiCrmEndpoint && deps.postNotification) {
    await deps.postNotification(yijiNotifyUrl, body, { 'idempotency-key': idempotencyKey });
    logger.info({ conversationId: data.conversationId }, 'customer push delivered to Yiji');
    return 'delivered';
  }

  const res = await doFetch(yijiNotifyUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(yijiApiKey ? { authorization: `Bearer ${yijiApiKey}` } : {}),
      'idempotency-key': idempotencyKey,
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
