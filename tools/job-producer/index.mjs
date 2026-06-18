/**
 * Job producer — host-run BullMQ enqueuer for the Yiji CRM imports/reports queues.
 *
 * The Dockerised workers service already CONSUMES the `imports` and `reports`
 * BullMQ queues, but nothing enqueues those jobs (the imports UI was
 * preview-only and reports had no "run"). This standalone tool (does NOT touch
 * the workers image) connects to the stack's Redis over the published host
 * port and exposes a tiny HTTP API the portals call to enqueue jobs the
 * already-running workers pick up and process.
 *
 * The worker dispatches by QUEUE NAME (services/workers/src/index.ts → one
 * Worker per queue, `processors[queue]`), so the BullMQ job NAME is cosmetic —
 * what must match EXACTLY is the queue name + the job `data` shape:
 *   imports → ImportJob  { fileId, vendorId, mapping }   (packages/shared-types/src/queues.ts)
 *   reports → ReportJob  { reportId }                     (packages/shared-types/src/queues.ts)
 *
 * Run:
 *   cd crm-app-infra/tools/job-producer
 *   npm install            # isolated; doesn't affect the monorepo
 *   node index.mjs         # → http://127.0.0.1:3031
 *
 * Env:
 *   REDIS_URL        default redis://127.0.0.1:6380  (the dev host mapping)
 *   JOB_PRODUCER_PORT  default 3031 (dedicated — NOT generic PORT, which collides)
 *   PRODUCER_TOKEN   optional — when set, requests must send a matching
 *                    `x-producer-token` header; unset => open (dev only).
 */
import express from 'express';
import cors from 'cors';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const PORT = Number(process.env.JOB_PRODUCER_PORT ?? 3031);
const PRODUCER_TOKEN = process.env.PRODUCER_TOKEN ?? '';

// Match QUEUES in packages/shared-types (exact queue names the workers consume).
const QUEUE_IMPORTS = 'imports';
const QUEUE_REPORTS = 'reports';

// Mirror DEFAULT_JOB_OPTIONS from packages/shared-types (retries + backoff).
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => console.error('redis error:', err.message));

const importsQueue = new Queue(QUEUE_IMPORTS, { connection });
const reportsQueue = new Queue(QUEUE_REPORTS, { connection });

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://localhost:5174'],
    allowedHeaders: ['content-type', 'x-producer-token'],
    methods: ['GET', 'POST', 'OPTIONS'],
  }),
);

// Light auth: only enforced when PRODUCER_TOKEN is set (dev runs open).
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' || req.path === '/health') return next();
  if (PRODUCER_TOKEN && req.get('x-producer-token') !== PRODUCER_TOKEN) {
    return res.status(401).json({ ok: false, error: 'invalid producer token' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /jobs/import  body { fileId, vendorId, mapping }
 * Enqueues an ImportJob the imports processor consumes (parses the uploaded
 * CSV, maps columns, upserts contacts with per-vendor dedup).
 */
app.post('/jobs/import', async (req, res) => {
  const { fileId, vendorId, mapping } = req.body ?? {};
  if (typeof fileId !== 'string' || typeof vendorId !== 'string') {
    return res.status(400).json({ ok: false, error: 'fileId and vendorId are required strings' });
  }
  if (mapping == null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return res.status(400).json({ ok: false, error: 'mapping must be an object' });
  }
  try {
    const job = await importsQueue.add(
      'import',
      { fileId, vendorId, mapping },
      DEFAULT_JOB_OPTIONS,
    );
    return res.json({ ok: true, jobId: job.id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /jobs/report  body { reportId }
 * Enqueues a ReportJob the reports processor consumes (runs the aggregation,
 * renders CSV, emails recipients, bumps last_run_at). Mirrors the shape
 * syncScheduledReports uses for scheduled runs ({ reportId }).
 */
app.post('/jobs/report', async (req, res) => {
  const { reportId } = req.body ?? {};
  if (typeof reportId !== 'string' || reportId.length === 0) {
    return res.status(400).json({ ok: false, error: 'reportId is required' });
  }
  try {
    const job = await reportsQueue.add('run-now', { reportId }, DEFAULT_JOB_OPTIONS);
    return res.json({ ok: true, jobId: job.id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Job producer → http://127.0.0.1:${PORT}  (Redis: ${REDIS_URL})`);
  console.log(`Queues: ${QUEUE_IMPORTS}, ${QUEUE_REPORTS}`);
  console.log(`Auth: ${PRODUCER_TOKEN ? 'x-producer-token required' : 'open (dev)'}`);
});
