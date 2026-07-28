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
 *   notifications → NotificationJob { recipientId, type, title, body, link?, payload? }
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
 *   DIRECTUS_URL     default http://127.0.0.1:8055 — used by
 *                    POST /jobs/notify-assignment to verify the caller and to
 *                    re-read the assigned entity SERVER-SIDE.
 *   SVC_GATEWAY_TOKEN  optional Directus service token used for that re-read
 *                    (mirrors the gateway). When unset we fall back to the
 *                    caller's own token, which in dev is usually enough.
 */
import express from 'express';
import cors from 'cors';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const PORT = Number(process.env.JOB_PRODUCER_PORT ?? 3031);
const PRODUCER_TOKEN = process.env.PRODUCER_TOKEN ?? '';
const DIRECTUS_URL = (process.env.DIRECTUS_URL ?? 'http://127.0.0.1:8055').replace(/\/+$/, '');
const SVC_GATEWAY_TOKEN = process.env.SVC_GATEWAY_TOKEN ?? '';

// Match QUEUES in packages/shared-types (exact queue names the workers consume).
const QUEUE_IMPORTS = 'imports';
const QUEUE_REPORTS = 'reports';
const QUEUE_NOTIFICATIONS = 'notifications';

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
const notificationsQueue = new Queue(QUEUE_NOTIFICATIONS, { connection });

const app = express();
app.use(express.json());
app.use(
  cors({
    // 5173 = agent portal, 5174 = admin portal (see each app's vite.config.ts).
    origin: ['http://localhost:5173', 'http://localhost:5174'],
    // `authorization` MUST be allowed: both portals send the logged-in user's
    // Directus token as a Bearer (the prod gateway authenticates on it), which
    // makes the request preflighted.
    allowedHeaders: ['content-type', 'authorization', 'x-producer-token'],
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

// --- assignment notifications (dev mirror of the gateway endpoint) ---
const STAFF_ROLES = new Set(['Agent', 'Admin', 'Administrator']);

function bearer(req) {
  const h = req.get('authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/** Verify the caller's Directus token → { id, role } (mirrors validateAgentToken). */
async function whoami(token) {
  try {
    const res = await fetch(`${DIRECTUS_URL}/users/me?fields=id,role.name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    return data?.id ? { id: data.id, role: data.role?.name ?? null } : null;
  } catch {
    return null;
  }
}

/** Re-read the entity server-side and return its CURRENT assignee + a label. */
async function loadAssignmentTarget(entityType, entityId, callerToken) {
  const token = SVC_GATEWAY_TOKEN || callerToken;
  const [collection, fields] =
    entityType === 'ticket'
      ? ['tickets', 'id,assigned_agent,subject']
      : ['conversations', 'id,assigned_agent,contact.name'];
  try {
    const url = `${DIRECTUS_URL}/items/${collection}/${encodeURIComponent(entityId)}?fields=${fields}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const { data } = await res.json();
    if (!data?.id) return null;
    return {
      id: data.id,
      assignedAgent: data.assigned_agent ?? null,
      label: (entityType === 'ticket' ? data.subject : data.contact?.name) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * POST /jobs/notify-assignment  body { entityType: 'conversation'|'ticket', entityId }
 *
 * SECURITY (identical contract to services/socket-gateway/src/index.ts): the
 * body may NOT carry a recipient/title/body — any agent can call this, so a
 * client-supplied recipient would be an in-app + email spam vector. The
 * recipient is the entity's CURRENT assigned_agent read back from Directus, and
 * the copy is built here. Self-assignment / unassigned enqueue nothing.
 */
app.post('/jobs/notify-assignment', async (req, res) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ ok: false, error: 'missing bearer token' });
  const identity = await whoami(token);
  if (!identity || !identity.role || !STAFF_ROLES.has(identity.role)) {
    return res.status(403).json({ ok: false, error: 'agent role required' });
  }

  const { entityType, entityId } = req.body ?? {};
  if (entityType !== 'conversation' && entityType !== 'ticket') {
    return res.status(400).json({ ok: false, error: 'invalid assignment payload' });
  }
  if (typeof entityId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entityId.trim())) {
    return res.status(400).json({ ok: false, error: 'invalid assignment payload' });
  }

  const entity = await loadAssignmentTarget(entityType, entityId.trim(), token);
  const assignee = entity?.assignedAgent ?? null;
  // Not found / unassigned / self-assign all answer as a successful no-op so the
  // caller can't probe entities it may not read.
  if (!entity || !assignee || assignee === identity.id) {
    return res.json({ ok: true, enqueued: false });
  }

  const label = (entity.label ?? '').trim();
  const notification =
    entityType === 'ticket'
      ? {
          recipientId: assignee,
          type: 'assignment',
          title: 'New ticket assigned to you',
          body: label
            ? `Ticket "${label}" was assigned to you.`
            : `Ticket ${entity.id} was assigned to you.`,
          link: `/tickets/${entity.id}`,
          payload: { entityType: 'ticket', ticketId: entity.id },
        }
      : {
          recipientId: assignee,
          type: 'assignment',
          title: 'New conversation assigned to you',
          body: label
            ? `A conversation with ${label} was assigned to you.`
            : 'A conversation was assigned to you.',
          link: `/?conv=${entity.id}`,
          payload: { entityType: 'conversation', conversationId: entity.id },
        };

  try {
    // Deterministic jobId (hyphens only — BullMQ rejects ':') so a double-click
    // collapses into a single queued notification.
    const job = await notificationsQueue.add('assignment', notification, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `assign-${entityType}-${entity.id}-${assignee}`,
    });
    return res.json({ ok: true, enqueued: true, jobId: job.id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Job producer → http://127.0.0.1:${PORT}  (Redis: ${REDIS_URL})`);
  console.log(`Queues: ${QUEUE_IMPORTS}, ${QUEUE_REPORTS}, ${QUEUE_NOTIFICATIONS}`);
  console.log(`Auth: ${PRODUCER_TOKEN ? 'x-producer-token required' : 'open (dev)'}`);
});
