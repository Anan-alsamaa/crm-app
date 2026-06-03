import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { QUEUES, type QueueName, type NotificationJob, type SlaJob } from '@yiji/shared-types';
import type { MailTransport } from '../mail/index.js';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { processSlaJob, type SlaDeps } from './sla.js';
import { processNotificationJob, type NotifDeps } from './notifications.js';
import { createTicketRepo, createNotificationsRepo } from './directus-repos.js';

/**
 * Queue processor registry.
 *   sla, notifications → implemented (US4).
 *   ai, automation, imports, reports → no-op stubs filled in later phases.
 */
export interface ProcessorDeps {
  logger: Logger;
  directus: YijiDirectusClient;
  mail: MailTransport;
  queues: Record<QueueName, Queue>;
  onInAppNotification?: (n: { id: string; recipient: string; type: string }) => void;
}

export type Processor = (job: Job, deps: ProcessorDeps) => Promise<void>;

const notImplemented =
  (queue: QueueName): Processor =>
  async (job, deps) => {
    deps.logger.warn({ queue, jobId: job.id, name: job.name }, 'processor not yet implemented');
  };

export const processors: Record<QueueName, Processor> = {
  [QUEUES.sla]: async (job, deps) => {
    const slaDeps: SlaDeps = {
      tickets: createTicketRepo(deps.directus),
      slaQueue: deps.queues[QUEUES.sla],
      notificationsQueue: deps.queues[QUEUES.notifications],
      logger: deps.logger,
    };
    await processSlaJob(
      job as Job<SlaJob & { deadline?: 'first_response' | 'resolution' }>,
      slaDeps,
    );
  },
  [QUEUES.notifications]: async (job, deps) => {
    const notifDeps: NotifDeps = {
      notifications: createNotificationsRepo(deps.directus),
      mail: deps.mail,
      logger: deps.logger,
      onInAppCreated: deps.onInAppNotification,
    };
    await processNotificationJob(job as Job<NotificationJob>, notifDeps);
  },
  [QUEUES.ai]: notImplemented(QUEUES.ai),
  [QUEUES.automation]: notImplemented(QUEUES.automation),
  [QUEUES.imports]: notImplemented(QUEUES.imports),
  [QUEUES.reports]: notImplemented(QUEUES.reports),
};

export { scheduleReconcile } from './sla.js';
