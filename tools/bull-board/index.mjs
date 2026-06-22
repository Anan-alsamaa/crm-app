/**
 * Bull Board — local queue dashboard for the Yiji CRM BullMQ queues.
 *
 * Standalone (does NOT touch the Dockerised workers image): it connects to the
 * stack's Redis over the published host port and serves a web UI showing every
 * queue's jobs (waiting / active / completed / failed / delayed), retries, and
 * the dead-letter queue.
 *
 * Run:
 *   cd crm-app-infra/tools/bull-board
 *   npm install            # isolated; doesn't affect the monorepo
 *   node index.mjs         # → http://127.0.0.1:3030
 *
 * Env:
 *   REDIS_URL        default redis://127.0.0.1:6380  (the dev host mapping)
 *   BULL_BOARD_PORT  default 3030
 */
import express from 'express';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const PORT = Number(process.env.BULL_BOARD_PORT ?? 3030);
// Keep in sync with QUEUES in packages/shared-types (the 6 worker queues).
const QUEUE_NAMES = ['sla', 'notifications', 'ai', 'automation', 'imports', 'reports'];

const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => console.error('redis error:', err.message));

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/');
createBullBoard({
  queues: QUEUE_NAMES.map((name) => new BullMQAdapter(new Queue(name, { connection }))),
  serverAdapter,
});

const app = express();
app.use('/', serverAdapter.getRouter());
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Bull Board → http://127.0.0.1:${PORT}  (Redis: ${REDIS_URL})`);
  console.log(`Queues: ${QUEUE_NAMES.join(', ')}`);
});
