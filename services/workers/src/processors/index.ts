import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import {
  QUEUES,
  type QueueName,
  type NotificationJob,
  type SlaJob,
  type AiJob,
  type AutomationJob,
  type ImportJob,
  type ReportJob,
} from '@yiji/shared-types';
import type { MailTransport } from '../mail/index.js';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { processSlaJob, type SlaDeps } from './sla.js';
import { processNotificationJob, type NotifDeps } from './notifications.js';
import { processAiJob, type AiDeps } from './ai.js';
import {
  processAutomationJob,
  runInactivitySweep,
  INACTIVITY_SWEEP_NAME,
  type AutomationDeps,
} from './automation.js';
import { processImportJob, type ImportsDeps } from './imports.js';
import { processReportJob, type ReportsDeps } from './reports.js';
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
  /** Directus URL + service token for the imports processor to download CSVs. */
  imports?: { directusUrl: string; directusToken: string };
  /** Minutes of silence before a conversation is swept as inactive. */
  inactivityMinutes?: number;
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
  [QUEUES.automation]: async (job, deps) => {
    // The recurring inactivity sweep shares the automation queue but isn't a
    // per-entity trigger — it fans out one inactivity job per stale conversation.
    if (job.name === INACTIVITY_SWEEP_NAME) {
      await runInactivitySweep({
        directus: deps.directus,
        automationQueue: deps.queues[QUEUES.automation],
        logger: deps.logger,
        thresholdMinutes: deps.inactivityMinutes ?? 120,
      });
      return;
    }
    const autoDeps: AutomationDeps = {
      directus: deps.directus,
      logger: deps.logger,
      notificationsQueue: deps.queues[QUEUES.notifications],
      automationQueue: deps.queues[QUEUES.automation],
    };
    await processAutomationJob(job as Job<AutomationJob>, autoDeps);
  },
  [QUEUES.imports]: async (job, deps) => {
    if (!deps.imports) {
      deps.logger.warn(
        { jobId: job.id },
        'imports processor invoked without imports deps configured',
      );
      return;
    }
    const importDeps: ImportsDeps = {
      directus: deps.directus,
      directusUrl: deps.imports.directusUrl,
      directusToken: deps.imports.directusToken,
      logger: deps.logger,
    };
    await processImportJob(job as Job<ImportJob>, importDeps);
  },
  [QUEUES.reports]: async (job, deps) => {
    const reportDeps: ReportsDeps = {
      directus: deps.directus,
      mail: deps.mail,
      logger: deps.logger,
    };
    await processReportJob(job as Job<ReportJob>, reportDeps);
  },
};

// `notImplemented` is no longer used now that every processor ships; retain
// the symbol export-free to keep the diff small. Remove on next refactor.
void notImplemented;

export { scheduleReconcile } from './sla.js';
export { scheduleInactivitySweep } from './automation.js';
export { syncScheduledReports } from './reports.js';
