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
  type RoutingJob,
  type CouponPushJob,
  type CustomerPushJob,
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
import { processCouponPushJob } from './coupon-push.js';
import { processCustomerPushJob } from './customer-push.js';
import { handleRouting } from '../routing.js';
import {
  createTicketRepo,
  createNotificationsRepo,
  createRoutingRepo,
  createTeamRepo,
} from './directus-repos.js';

/**
 * Queue processor registry — every queue (sla, notifications, ai, automation,
 * imports, reports) is backed by a real processor.
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

export const processors: Record<QueueName, Processor> = {
  [QUEUES.sla]: async (job, deps) => {
    const slaDeps: SlaDeps = {
      tickets: createTicketRepo(deps.directus),
      teams: createTeamRepo(deps.directus),
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
  [QUEUES.routing]: async (job, deps) => {
    const routingJob = job.data as RoutingJob;
    await handleRouting(routingJob, {
      // The queue's own Redis connection doubles as the presence reader — the
      // gateway writes the online set to the same instance.
      redis: (deps.queues[QUEUES.routing].opts.connection ?? {}) as never,
      directus: createRoutingRepo(deps.directus),
      schedule: async (next, delayMs) => {
        await deps.queues[QUEUES.routing].add(next.stage, next, {
          delay: delayMs,
          jobId: `route-${next.stage}-${next.conversationId}-${Date.now()}`,
        });
      },
      log: (msg, extra) => deps.logger.info(extra ?? {}, msg),
    });
  },
  [QUEUES.coupons]: async (job, deps) => {
    await processCouponPushJob(job as Job<CouponPushJob>, {
      directus: deps.directus,
      logger: deps.logger,
      // Blank disables delivery and leaves the request `approved` — see the
      // note in coupon-push.ts on why that is not treated as a success.
      yijiCouponUrl: process.env.YIJI_COUPON_URL ?? '',
      yijiApiKey: process.env.YIJI_API_KEY ?? '',
    });
  },
  [QUEUES.customerPush]: async (job, deps) => {
    await processCustomerPushJob(job as Job<CustomerPushJob>, {
      logger: deps.logger,
      // Blank disables delivery and logs the payload — the concrete thing to
      // hand the mobile developer when agreeing the contract.
      yijiNotifyUrl: process.env.YIJI_NOTIFY_URL ?? '',
      yijiApiKey: process.env.YIJI_API_KEY ?? '',
    });
  },
};

export { scheduleReconcile } from './sla.js';
export { scheduleInactivitySweep } from './automation.js';
export { syncScheduledReports } from './reports.js';
