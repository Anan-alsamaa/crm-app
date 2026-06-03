import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { QUEUES, type QueueName, type NotificationJob, type SlaJob, type AiJob } from '@yiji/shared-types';
import type { MailTransport } from '../mail/index.js';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { processSlaJob, type SlaDeps } from './sla.js';
import { processNotificationJob, type NotifDeps } from './notifications.js';
import { processAiJob, type AiDeps } from './ai.js';
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
  /** AI gateway URL + service token — used by the `ai` processor. */
  ai?: { gatewayUrl: string; gatewayToken: string; workerUserId: string };
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
  [QUEUES.ai]: async (job, deps) => {
    if (!deps.ai) {
      deps.logger.warn({ jobId: job.id }, 'ai processor invoked without AI deps configured');
      return;
    }
    const aiDeps: AiDeps = {
      directus: deps.directus,
      gatewayUrl: deps.ai.gatewayUrl,
      gatewayToken: deps.ai.gatewayToken,
      workerUserId: deps.ai.workerUserId,
      logger: deps.logger,
    };
    await processAiJob(job as Job<AiJob>, aiDeps);
  },
  [QUEUES.automation]: notImplemented(QUEUES.automation),
  [QUEUES.imports]: notImplemented(QUEUES.imports),
  [QUEUES.reports]: notImplemented(QUEUES.reports),
};

export { scheduleReconcile } from './sla.js';
