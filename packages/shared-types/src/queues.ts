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

/** Default BullMQ job options (retries + backoff; dead-letter via failed state). */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};
