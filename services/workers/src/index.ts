/**
 * workers entrypoint.
 *
 * Spins up one BullMQ Worker per queue. Each processor receives a shared
 * Directus client, MailTransport, and Queue map (so processors can re-enqueue
 * cross-queue jobs — e.g. SLA → notification fanout). The SLA reconcile sweep
 * is scheduled at startup as a repeatable job.
 */
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import pino from 'pino';
import { createServiceClient } from '@yiji/shared-config';
import { QUEUES, type QueueName } from '@yiji/shared-types';
import { loadConfig } from './config.js';
import { createMailTransport } from './mail/index.js';
import { processors, scheduleReconcile, type ProcessorDeps } from './processors/index.js';

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
  const queues = Object.fromEntries(
    queueNames.map((name) => [name, new Queue(name, { connection })]),
  ) as Record<QueueName, Queue>;

  // Recurring SLA reconcile sweep every 60s (research D-04).
  await scheduleReconcile(queues[QUEUES.sla], 60_000);
  logger.info('SLA reconcile sweep scheduled (every 60s)');

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
  };
  const workers = queueNames.map(
    (queue) =>
      new Worker(
        queue,
        async (job) => {
          const processor = processors[queue];
          await processor(job, deps);
        },
        { connection },
      ),
  );
  for (const w of workers) {
    w.on('failed', (job, err) =>
      logger.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'),
    );
  }
  logger.info(`workers started for queues: ${Object.values(QUEUES).join(', ')}`);

  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    if (connection.status !== 'ready')
      return reply.code(503).send({ status: 'not-ready', redis: connection.status });
    return { status: 'ready' };
  });
  await app.listen({ port: config.HEALTH_PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down — draining workers');
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
