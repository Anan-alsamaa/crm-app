import { z } from 'zod';
import { AutomationTrigger, NotificationType } from './enums.js';

/**
 * BullMQ queue names + job payloads (contracts/queues.md).
 * Producers (gateway, Directus hooks, workers) and the workers service share these.
 */

export const QUEUES = {
  sla: 'sla',
  notifications: 'notifications',
  ai: 'ai',
  automation: 'automation',
  imports: 'imports',
  reports: 'reports',
  routing: 'routing',
  coupons: 'coupons',
  customerPush: 'customer-push',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// --- sla ---
export const SlaJob = z.object({
  ticketId: z.string(),
  kind: z.enum(['warning', 'breach', 'reconcile']),
  dueAt: z.string().datetime().optional(),
});
export type SlaJob = z.infer<typeof SlaJob>;

// --- notifications ---
export const NotificationJob = z.object({
  recipientId: z.string(),
  type: NotificationType,
  title: z.string(),
  body: z.string(),
  link: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});
export type NotificationJob = z.infer<typeof NotificationJob>;

// --- ai ---
export const AiJob = z.object({
  job: z.enum(['summarize', 'score_lead']),
  conversationId: z.string(),
});
export type AiJob = z.infer<typeof AiJob>;

// --- automation ---
export const AutomationJob = z.object({
  triggerEvent: AutomationTrigger,
  entity: z.object({ type: z.string(), id: z.string() }),
  context: z.record(z.unknown()).default({}),
  _depth: z.number().int().nonnegative().default(0),
});
export type AutomationJob = z.infer<typeof AutomationJob>;
/** Max automation re-trigger depth (loop prevention, D-08). */
export const AUTOMATION_MAX_DEPTH = 5;

// --- imports ---
export const ImportJob = z.object({
  fileId: z.string(),
  vendorId: z.string(),
  mapping: z.record(z.string()),
});
export type ImportJob = z.infer<typeof ImportJob>;

// --- reports ---
export const ReportJob = z.object({ reportId: z.string() });
export type ReportJob = z.infer<typeof ReportJob>;

// --- routing (auto-assignment) ---
/**
 * Hand an unassigned conversation to ONE agent, then escalate if they go quiet.
 *
 * Broadcasting every new chat to every agent means either everyone answers or
 * nobody does — the diffusion-of-responsibility problem. So a conversation is
 * given to a single named agent, and the stages below exist to make sure a
 * silent agent cannot strand a waiting customer:
 *
 *   assign    -> pick the idlest ONLINE agent and give it to them
 *   escalate  -> they did not reply in ROUTING_FIRST_WAIT_MS, try the next agent
 *   broadcast -> still no reply after ROUTING_SECOND_WAIT_MS, release it to the
 *                whole pool, which is the honest fallback rather than letting it
 *                sit with someone who is clearly unavailable
 *
 * `attemptedAgentIds` is carried so escalation never re-offers the conversation
 * to an agent who has already had their turn.
 */
export const RoutingJob = z.object({
  conversationId: z.string(),
  stage: z.enum(['assign', 'escalate', 'broadcast']),
  attemptedAgentIds: z.array(z.string()).default([]),
  /**
   * Message count at the moment the timer was scheduled. A later stage compares
   * against it: if an agent replied, the count moved and the escalation is
   * dropped. Comparing counts rather than timestamps avoids depending on clock
   * agreement between the gateway and the workers.
   */
  outboundCountAtSchedule: z.number().int().nonnegative().default(0),
});
export type RoutingJob = z.infer<typeof RoutingJob>;

/** No reply in this long → try a different agent. */
export const ROUTING_FIRST_WAIT_MS = 60_000;
/** Still no reply → release to every agent. */
export const ROUTING_SECOND_WAIT_MS = 30_000;

// --- coupons ---
/**
 * "This coupon was approved — tell Yiji about it."
 *
 * Queued rather than pushed from the approval itself, and this is the whole
 * reason the queue exists: Yiji being down, slow, or mid-deploy must never make
 * a supervisor's approval fail. The decision is recorded in the CRM the moment
 * they make it; telling Yiji is a separate promise the workers keep, with the
 * retries and backoff every other job gets.
 *
 * Carries only the id. The worker re-reads the approval with its own service
 * token, so an amended coupon cannot be pushed with the terms the agent
 * originally asked for, and a request that was reversed between queueing and
 * delivery is not pushed at all.
 */
export const CouponPushJob = z.object({
  couponApprovalId: z.string().min(1),
});
export type CouponPushJob = z.infer<typeof CouponPushJob>;

/** Default BullMQ job options (retries + backoff; dead-letter via failed state). */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

/**
 * What the store QR page posts to open a walk-in chat session.
 *
 * Phone is the only thing asked of the customer, and it is the only thing that
 * identifies them — so it is validated here rather than trusted. The pattern is
 * deliberately loose (digits, spaces, +, dashes, parens) because Saudi numbers
 * are written half a dozen ways on a shop counter and rejecting a valid one is
 * worse than accepting a malformed one the gateway will simply fail to match.
 */
export const WalkInSessionRequest = z.object({
  phone: z
    .string()
    .trim()
    .min(7, 'phone is too short')
    .max(24, 'phone is too long')
    .regex(/^[+()\-\s\d]+$/, 'phone may only contain digits and + - ( ) spaces'),
  vendorId: z.string().min(1),
});
export type WalkInSessionRequest = z.infer<typeof WalkInSessionRequest>;

/**
 * Ask for a personal walk-in link for ONE customer.
 *
 * Admin-only. The response carries a signed token, never the number: see
 * `WalkInCode` for why a short code beats both a phone number and a signed
 * token in the query string.
 */
export const WalkInLinkRequest = z.object({
  phone: WalkInSessionRequest.shape.phone,
  vendorId: z.string().min(1),
  /** How long the link should work for. Default 7 days, capped at 30. */
  days: z.coerce.number().int().min(1).max(30).optional(),
});
export type WalkInLinkRequest = z.infer<typeof WalkInLinkRequest>;

/**
 * Crockford base32 — no I, L, O or U.
 *
 * Those four are what turn a code read off a printed card, or over the phone,
 * into a support call: 1/I/l and 0/O are indistinguishable in most typefaces.
 * Dropping them costs a little keyspace and removes the whole class of problem.
 */
export const WALK_IN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const WALK_IN_CODE_LENGTH = 10;

/** The code as it appears in a link. Upper-cased, so a typed link still works. */
export const WalkInCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(
    z
      .string()
      .length(WALK_IN_CODE_LENGTH)
      .regex(new RegExp(`^[${WALK_IN_CODE_ALPHABET}]+$`), 'not a walk-in code'),
  );

/** Open a session from a personal link. */
export const WalkInCodeRequest = z.object({ code: WalkInCode });
export type WalkInCodeRequest = z.infer<typeof WalkInCodeRequest>;

// --- customer-push ---
/**
 * Tell a customer's PHONE that an agent replied while they were away.
 *
 * The widget already says "we will get back to you" when nobody is online. The
 * gap is the other half: the reply lands hours later in a chat the customer
 * closed, and nothing tells them. Only the Yiji mobile app can raise a
 * notification on their handset, so this job carries what the app needs to
 * find the customer and show something useful.
 *
 * The message PREVIEW is included deliberately but is the agent's own words,
 * truncated — not a summary and not the whole thread. A notification that says
 * only "you have a reply" makes people open the app to find out whether it
 * mattered; one that quotes the entire conversation leaks it to a lock screen.
 */
export const CustomerPushJob = z.object({
  conversationId: z.string(),
  /** E.164, the same canonical form contacts are stored in. */
  phone: z.string().nullable(),
  /** The Yiji customer id when we have one — the app's own key. */
  externalCustomerId: z.string().nullable(),
  /** First line of the agent's reply, for the notification body. */
  preview: z.string(),
  /** When the reply was sent, so a delayed push can say so. */
  sentAt: z.string(),
});
export type CustomerPushJob = z.infer<typeof CustomerPushJob>;
