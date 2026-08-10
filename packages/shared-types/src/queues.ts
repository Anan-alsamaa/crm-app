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

/** Default BullMQ job options (retries + backoff; dead-letter via failed state). */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};
