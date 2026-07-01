/**
 * workers entrypoint.
 *
 * Spins up one BullMQ Worker per queue. Each processor receives a shared
 * Directus client, MailTransport, and Queue map (so processors can re-enqueue
 * cross-queue jobs — e.g. SLA → notification fanout). The SLA reconcile sweep
 * is scheduled at startup as a repeatable job. Fastify serves /health, /ready
 * and /metrics.
 */
import './telemetry.js'; // MUST be first: starts OTel before http/ioredis load.
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import pino from 'pino';
import { createServiceClient } from '@yiji/shared-config';
import { QUEUES, type QueueName } from '@yiji/shared-types';
import { loadConfig } from './config.js';
import { createMailTransport } from './mail/index.js';
import {
  processors,
  scheduleReconcile,
  scheduleInactivitySweep,
  syncScheduledReports,
  type ProcessorDeps,
} from './processors/index.js';
import { Registry } from './metrics.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: 'workers' });

  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (a) => Math.min(a * 200, 5000),
  });
  connection.on('error', (err) => logger.warn({ err: err.message }, 'redis error (retrying)'));

  const directus = createServiceClient({
    url: config.DIRECTUS_INTERNAL_URL,
    token: config.SVC_WORKERS_TOKEN,
  });
  const mail = createMailTransport(config, logger);

  // One Queue per queue name (used by SLA processor to schedule warning/breach
  // and to enqueue notifications cross-queue).
  const queueNames = Object.values(QUEUES) as QueueName[];
  // Retries (attempts + exponential backoff) are enabled ONLY for the
  // notifications queue: its job is idempotent under retry (see notifications.ts —
  // nothing after the in-app row insert throws, so a retry never double-sends).
  // The other queues stay at BullMQ's default attempts:1 because their jobs create
  // rows/events that would DUPLICATE on a blind retry (imports rows, automation
  // ticket_events); retrying them safely needs per-job dedup keys — tracked as a
  // follow-up, deliberately not enabled here.
  const queues = Object.fromEntries(
    queueNames.map((name) => [
      name,
      new Queue(name, {
        connection,
        ...(name === QUEUES.notifications
          ? { defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } } }
          : {}),
      }),
    ]),
  ) as Record<QueueName, Queue>;

  // --- Metrics ---
  const metrics = new Registry();
  metrics.collectDefaultMetrics('workers');
  const jobsProcessed = metrics.counter('bullmq_jobs_completed_total', 'BullMQ jobs completed.');
  const jobsFailed = metrics.counter('bullmq_jobs_failed_total', 'BullMQ jobs failed.');
  const queueDepth = metrics.gauge('bullmq_queue_jobs', 'BullMQ jobs by queue and state.');

  // Recurring SLA reconcile sweep every 60s (research D-04).
  await scheduleReconcile(queues[QUEUES.sla], 60_000);
  logger.info('SLA reconcile sweep scheduled (every 60s)');

  // Recurring inactivity sweep — enqueues `inactivity` automation triggers for
  // conversations gone quiet past the threshold (default 120m, every 5m).
  const inactivityMinutes = Number(process.env.INACTIVITY_MINUTES ?? 120);
  await scheduleInactivitySweep(queues[QUEUES.automation], 5 * 60_000);
  logger.info({ inactivityMinutes }, 'inactivity sweep scheduled (every 5m)');

  // Scheduled reports (§16/§18): register a BullMQ Job Scheduler per report that
  // has a `schedule.cron`, so BullMQ fires it and the reports worker generates +
  // emails it. Re-sync every 5 min so admin-created/edited reports are picked up
  // without a restart. Startup sync is best-effort — if Directus is momentarily
  // unreachable the periodic timer retries.
  try {
    const { active } = await syncScheduledReports(queues[QUEUES.reports], { directus, logger });
    logger.info({ active }, 'scheduled reports synced at startup');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'initial scheduled-reports sync failed (retrying)',
    );
  }
  const reportSyncTimer = setInterval(() => {
    void syncScheduledReports(queues[QUEUES.reports], { directus, logger }).catch((err) =>
      logger.warn({ err: (err as Error).message }, 'scheduled-reports re-sync failed'),
    );
  }, 5 * 60_000);
  reportSyncTimer.unref();

  const deps: ProcessorDeps = {
    logger,
    directus,
    mail,
    queues,
    ai: config.SVC_AI_TOKEN
      ? {
          gatewayUrl: config.AI_GATEWAY_URL,
          gatewayToken: config.SVC_AI_TOKEN,
          workerUserId: config.AI_WORKER_USER_ID,
        }
      : undefined,
    imports: {
      directusUrl: config.DIRECTUS_INTERNAL_URL,
      directusToken: config.SVC_WORKERS_TOKEN,
    },
    inactivityMinutes,
  };
  // Bounded parallelism per queue. Jobs are independent, so concurrency is safe
  // (unlike retries) — it just lets a worker process several jobs at once instead
  // of strictly one at a time (BullMQ's default). Tune via WORKER_CONCURRENCY.
  const workerConcurrency = Number(process.env.WORKER_CONCURRENCY ?? 5);
  const workers = queueNames.map(
    (queue) =>
      new Worker(
        queue,
        async (job) => {
          const processor = processors[queue];
          await processor(job, deps);
        },
        { connection, concurrency: workerConcurrency },
      ),
  );
  for (const w of workers) {
    w.on('completed', () => jobsProcessed.inc({ queue: w.name }));
    w.on('failed', (job, err) => {
      jobsFailed.inc({ queue: w.name });
      logger.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed');
    });
  }
  logger.info(`workers started for queues: ${Object.values(QUEUES).join(', ')}`);

  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.removeHeader('X-Powered-By');
    return payload;
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    if (connection.status !== 'ready')
      return reply.code(503).send({ status: 'not-ready', checks: { redis: connection.status } });
    try {
      if ((await connection.ping()) !== 'PONG')
        return reply.code(503).send({ status: 'not-ready', checks: { redis: 'no-pong' } });
    } catch {
      return reply.code(503).send({ status: 'not-ready', checks: { redis: 'unreachable' } });
    }
    return { status: 'ready', checks: { redis: 'ok' } };
  });
  app.get('/metrics', async (_req, reply) => {
    // Refresh queue-depth gauges from BullMQ before rendering (async work that
    // can't live in a synchronous onCollect hook).
    await Promise.all(
      queueNames.map(async (name) => {
        try {
          const counts = await queues[name].getJobCounts(
            'waiting',
            'active',
            'delayed',
            'failed',
            'completed',
          );
          for (const [state, value] of Object.entries(counts)) {
            queueDepth.set(value, { queue: name, state });
          }
        } catch {
          // Redis hiccup — leave the last-known gauge values in place.
        }
      }),
    );
    reply.header('content-type', metrics.contentType);
    return metrics.render();
  });
  await app.listen({ port: config.HEALTH_PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down — draining workers');
    clearInterval(reportSyncTimer);
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(queues).map((q) => q.close()));
    await app.close();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('workers failed to start:', err);
  process.exit(1);
});
