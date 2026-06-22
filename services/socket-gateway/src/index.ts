/**
 * socket-gateway entrypoint (US2).
 *
 * Stateless Socket.IO server. When REDIS_ENABLED, uses the Redis adapter for
 * cross-instance fanout (horizontal scaling, SC-010) + BullMQ side-effect jobs.
 * When disabled, runs a single in-memory instance so it works locally without
 * Redis. Fastify serves /health + /ready + /metrics; pino logging; graceful
 * shutdown.
 */
import './telemetry.js'; // MUST be first: starts OTel before http/ioredis load.
import { createServer } from 'node:http';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { Redis } from 'ioredis';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import pino from 'pino';
import { ImportJob, ReportJob } from '@yiji/shared-types';
import { loadConfig } from './config.js';
import { GatewayDirectus } from './directus.js';
import { createHs256Verifier } from './auth/customer-jwt.js';
import { validateAgentToken } from './auth/agent-jwt.js';
import { createProducer } from './queue.js';
import { registerConnection, getAgentPresenceSnapshot } from './connection.js';
import { Registry } from './metrics.js';
import { parseAttachmentPolicy } from './attachments.js';
import { verifyWebhookSignature } from './webhook.js';

/** Reachability ping to Directus /server/health with a hard timeout. */
async function pingDirectus(url: string, timeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/server/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Standard hardening headers for the (internal) health/metrics endpoints. */
function applySecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.removeHeader('X-Powered-By');
    return payload;
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: 'socket-gateway' });

  const httpServer = createServer();
  // A CORS value may be '*' or a comma-separated allow-list. Socket.IO + our
  // /jobs handler treat a bare string as a single literal origin, so split a
  // list into an array — otherwise every browser Origin is rejected.
  const parseCors = (v: string): '*' | string[] =>
    v.trim() === '*'
      ? '*'
      : v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
  // Two surfaces, two policies: the customer widget socket is embedded on
  // arbitrary vendor sites (defaults to '*', gated by the signed JWT), while the
  // admin/AI REST (e.g. POST /jobs/*) stays pinned to CORS_ORIGIN.
  const corsOrigin = parseCors(config.CORS_ORIGIN);
  const widgetCorsOrigin = parseCors(config.WIDGET_CORS_ORIGIN);
  const io = new SocketServer(httpServer, { cors: { origin: widgetCorsOrigin } });

  // --- Metrics ---
  const metrics = new Registry();
  metrics.collectDefaultMetrics('socket-gateway');
  const connectionsTotal = metrics.counter(
    'socket_connections_total',
    'Total Socket.IO connections accepted since start.',
  );
  const activeConnections = metrics.gauge(
    'socket_active_connections',
    'Currently connected Socket.IO clients on this instance.',
  );
  activeConnections.onCollect(() => activeConnections.set(io.engine.clientsCount ?? 0));
  io.on('connection', () => connectionsTotal.inc());

  let pubClient: Redis | undefined;
  let subClient: Redis | undefined;
  if (config.REDIS_ENABLED) {
    // maxRetriesPerRequest=null + retry strategy: survive Redis hiccups (e.g.
    // WSL restart) instead of throwing MaxRetriesPerRequestError and exiting.
    const redisOpts = {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (attempts: number) => Math.min(attempts * 200, 5000),
    } as const;
    pubClient = new Redis(config.REDIS_URL, redisOpts);
    subClient = pubClient.duplicate();
    pubClient.on('error', (err) => logger.warn({ err: err.message }, 'redis pub error (retrying)'));
    subClient.on('error', (err) => logger.warn({ err: err.message }, 'redis sub error (retrying)'));
    await pubClient.connect();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Redis adapter enabled (multi-instance, auto-reconnect)');
  } else {
    logger.warn('REDIS_ENABLED=false — single in-memory instance, side-effects skipped');
  }

  const directus = new GatewayDirectus(config.DIRECTUS_INTERNAL_URL, config.SVC_GATEWAY_TOKEN);
  const verifier = createHs256Verifier(config.YIJI_JWT_SECRET);
  const producer = createProducer(
    { redisEnabled: config.REDIS_ENABLED, redisUrl: config.REDIS_URL },
    logger,
  );

  registerConnection({
    io,
    directus,
    directusUrl: config.DIRECTUS_INTERNAL_URL,
    verifier,
    producer,
    logger,
    attachmentPolicy: parseAttachmentPolicy(
      config.ATTACHMENT_MAX_BYTES,
      config.ATTACHMENT_ALLOWED_MIME,
    ),
    rateLimit: {
      capacity: config.MSG_RATE_CAPACITY,
      refillPerSec: config.MSG_RATE_REFILL_PER_SEC,
    },
  });

  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  applySecurityHeaders(app);

  // CORS for the admin-triggered enqueue endpoints (POST /jobs/* from the admin
  // portal running in a browser). Every other endpoint here is internal or
  // server-to-server, so CORS stays scoped to /jobs/*. The allow-list is the
  // same CORS_ORIGIN the Socket.IO server uses.
  const allowCorsOrigin = (originHeader: string | string[] | undefined): string | null => {
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (corsOrigin === '*') return '*';
    return origin && corsOrigin.includes(origin) ? origin : null;
  };
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/jobs/')) return;
    const allow = allowCorsOrigin(req.headers.origin);
    if (allow) {
      reply.header('Access-Control-Allow-Origin', allow);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'content-type, authorization, x-producer-token');
      reply.header('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });
  // The global security onSend sets CORP: same-origin; relax it to cross-origin
  // for /jobs/* so the cross-origin admin portal can read the JSON response.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/jobs/')) reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return payload;
  });

  // Replace the default JSON parser with one that also retains the raw body, so
  // the webhook HMAC can be computed over the exact bytes the sender signed.
  // Fastify ships a default application/json parser, so we must remove it before
  // registering ours (adding a duplicate throws FST_ERR_CTP_ALREADY_PRESENT and
  // would crash the gateway on boot). Other endpoints are GETs with no body.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;

    if (config.REDIS_ENABLED) {
      try {
        const pong = pubClient && (await pubClient.ping());
        checks.redis = pong === 'PONG' ? 'ok' : (pubClient?.status ?? 'unknown');
        if (pong !== 'PONG') ready = false;
      } catch {
        checks.redis = 'unreachable';
        ready = false;
      }
    } else {
      checks.redis = 'disabled';
    }

    const directusOk = await pingDirectus(config.DIRECTUS_INTERNAL_URL);
    checks.directus = directusOk ? 'ok' : 'unreachable';
    if (!directusOk) ready = false;

    if (!ready) return reply.code(503).send({ status: 'not-ready', checks });
    return { status: 'ready', checks };
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.contentType);
    return metrics.render();
  });
  // Inbound webhook receiver (e.g. Yiji platform events). Rejects anything
  // without a valid HMAC signature + fresh timestamp. Disabled (503) until a
  // secret is configured, so it is never an unauthenticated open endpoint.
  app.post('/webhooks/yiji', async (req, reply) => {
    if (!config.YIJI_WEBHOOK_SECRET) {
      return reply.code(503).send({ status: 'webhooks-not-configured' });
    }
    const result = verifyWebhookSignature({
      secret: config.YIJI_WEBHOOK_SECRET,
      rawBody: (req as { rawBody?: string }).rawBody ?? '',
      signature: req.headers['x-yiji-signature'] as string | undefined,
      timestamp: req.headers['x-yiji-timestamp'] as string | undefined,
      toleranceSec: config.WEBHOOK_TOLERANCE_SEC,
    });
    if (!result.valid) {
      logger.warn({ reason: result.reason }, 'webhook signature rejected');
      return reply.code(401).send({ status: 'invalid-signature' });
    }
    const event = (req.body as { type?: string } | undefined)?.type ?? 'unknown';
    logger.info({ event }, 'webhook accepted');
    // Signature verified. Downstream processing (fan-out / enqueue) is wired by
    // the consuming pipeline; we acknowledge receipt here.
    return reply.code(202).send({ status: 'accepted', event });
  });

  // Admin-triggered job enqueue (admin portal → gateway). "Import CSV" and
  // "Run report now" post here; the gateway enqueues onto the same BullMQ queues
  // the workers consume (job NAME is cosmetic — queue + data shape must match).
  // Auth: the caller's Directus access token must resolve to Admin/Administrator.
  // (Scheduled reports are enqueued by the workers themselves, not this path.)
  const ADMIN_ROLES = new Set(['Admin', 'Administrator']);
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const raw = req.headers['authorization'];
    const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      await reply.code(401).send({ ok: false, error: 'missing bearer token' });
      return false;
    }
    const identity = await validateAgentToken(config.DIRECTUS_INTERNAL_URL, token);
    if (!identity || !identity.role || !ADMIN_ROLES.has(identity.role)) {
      await reply.code(403).send({ ok: false, error: 'admin role required' });
      return false;
    }
    return true;
  };
  app.post('/jobs/import', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const parsed = ImportJob.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, error: 'invalid import job payload' });
    const jobId = await producer.enqueueImport(parsed.data);
    if (jobId === null)
      return reply.code(503).send({ ok: false, error: 'queue disabled (no Redis)' });
    logger.info({ jobId }, 'admin enqueued contact import');
    return reply.send({ ok: true, jobId });
  });
  app.post('/jobs/report', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const parsed = ReportJob.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, error: 'invalid report job payload' });
    const jobId = await producer.enqueueReport(parsed.data);
    if (jobId === null)
      return reply.code(503).send({ ok: false, error: 'queue disabled (no Redis)' });
    logger.info({ jobId }, 'admin enqueued report run');
    return reply.send({ ok: true, jobId });
  });
  // Diagnostic: inspect which agents the gateway thinks are currently
  // online (and how many sockets each is holding). Useful for chasing the
  // "host page shows online after logout" class of bugs — if this returns
  // distinctOnline > 0 right after you signed out, the gateway is the
  // source of truth saying you're still online, and the offending sockets
  // are listed in `agents`.
  app.get('/debug/presence', async () => getAgentPresenceSnapshot());

  httpServer.listen(config.PORT, () => logger.info(`socket-gateway on :${config.PORT}`));
  await app.listen({ port: config.PORT + 1, host: '0.0.0.0' });
  logger.info(`health + metrics endpoints on :${config.PORT + 1}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    io.close();
    await app.close();
    httpServer.close();
    await producer.close();
    if (pubClient) await pubClient.quit();
    if (subClient) await subClient.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('socket-gateway failed to start:', err);
  process.exit(1);
});
