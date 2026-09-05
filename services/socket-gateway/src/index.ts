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
import type { Redis, Cluster } from 'ioredis';
import { createRedis } from '@yiji/shared-config/redis';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import pino from 'pino';
import {
  CouponPushJob,
  ImportJob,
  normalizePhone,
  phoneCustomerId,
  ReportJob,
  WALK_IN_CODE_ALPHABET,
  WALK_IN_CODE_LENGTH,
  WalkInCodeRequest,
  WalkInLinkRequest,
  WalkInSessionRequest,
} from '@yiji/shared-types';
import { loadConfig } from './config.js';
import { GatewayDirectus } from './directus.js';
import { createHs256Verifier } from './auth/customer-jwt.js';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { createTokenBucket } from './rate-limit.js';
import { validateAgentToken } from './auth/agent-jwt.js';
import { createProducer } from './queue.js';
import { createPresenceStore } from './presence-store.js';
import { registerConnection, getAgentPresenceSnapshot } from './connection.js';
import { Registry } from './metrics.js';
import { parseAttachmentPolicy } from './attachments.js';
import { verifyWebhookSignature } from './webhook.js';
import { notifyAssignment } from './assignment-notify.js';

/**
 * A link code: ten characters of Crockford base32, from a CSPRNG.
 *
 * `Math.random` is not acceptable here. Opening one of these links opens a chat
 * AS that customer, so a predictable generator is the same enumeration hole a
 * `?phone=` would have been — just harder to notice.
 *
 * Rejection sampling rather than `% 32`: the alphabet is exactly 32 characters
 * so a byte modulo 32 is uniform, but writing it that way invites the next
 * person to change the alphabet length and quietly introduce bias.
 */
function walkInCode(): string {
  const bytes = randomBytes(WALK_IN_CODE_LENGTH * 2);
  let out = '';
  for (const b of bytes) {
    if (out.length === WALK_IN_CODE_LENGTH) break;
    if (b >= 256 - (256 % WALK_IN_CODE_ALPHABET.length)) continue;
    out += WALK_IN_CODE_ALPHABET[b % WALK_IN_CODE_ALPHABET.length];
  }
  return out.padEnd(WALK_IN_CODE_LENGTH, WALK_IN_CODE_ALPHABET[0]);
}

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
  // `transports` is EXPLICIT because the default (polling, then upgrade) is unsafe
  // behind a load balancer running more than one task: the long-polling handshake
  // spans several HTTP requests, and without sticky sessions each one can land on
  // a different instance, which answers "Session ID unknown". The symptom only
  // appears at 2+ tasks, so it passes every single-instance test.
  //
  // Default keeps the polling fallback (the customer widget is embedded on
  // arbitrary vendor storefronts, some behind WebSocket-blocking proxies) and
  // REQUIRES stickiness on the ALB target group. Set SOCKET_TRANSPORTS=websocket
  // to drop the fallback and remove the stickiness requirement entirely.
  const io = new SocketServer(httpServer, {
    cors: { origin: widgetCorsOrigin },
    transports: config.SOCKET_TRANSPORTS,
  });

  // Say the operational requirement OUT LOUD at boot. Missing stickiness cannot
  // be detected from inside the process — the failure appears only at 2+ tasks,
  // as clients that connect then immediately disconnect — so the one thing this
  // process CAN do is state the dependency where an operator will see it.
  if (config.SOCKET_TRANSPORTS.includes('polling')) {
    logger.warn(
      { transports: config.SOCKET_TRANSPORTS },
      'polling transport enabled: the load balancer target group MUST have ' +
        'stickiness turned on, or handshakes break once more than one task runs. ' +
        'Set SOCKET_TRANSPORTS=websocket to remove that requirement.',
    );
  } else {
    logger.info({ transports: config.SOCKET_TRANSPORTS }, 'websocket-only: no stickiness required');
  }

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

  let pubClient: Redis | Cluster | undefined;
  let subClient: Redis | Cluster | undefined;
  if (config.REDIS_ENABLED) {
    // maxRetriesPerRequest=null + retry strategy: survive Redis hiccups (e.g.
    // WSL restart) instead of throwing MaxRetriesPerRequestError and exiting.
    const redisOpts = {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (attempts: number) => Math.min(attempts * 200, 5000),
    } as const;
    // createRedis(), NOT `new Redis()`: on a cluster-mode ElastiCache the
    // `clustercfg.` endpoint answers with MOVED redirects that a standalone
    // client cannot follow, so the adapter's pub/sub silently stops working and
    // agents on different instances stop seeing each other's messages. This is
    // the same fix already applied to the BullMQ producer in queue.ts.
    //
    // Two independent clients rather than `.duplicate()` — a Cluster's duplicate
    // does not carry the dnsLookup override the factory installs for
    // ElastiCache's private node addresses.
    pubClient = createRedis(config.REDIS_URL, redisOpts);
    subClient = createRedis(config.REDIS_URL, redisOpts);
    pubClient.on('error', (err) => logger.warn({ err: err.message }, 'redis pub error (retrying)'));
    subClient.on('error', (err) => logger.warn({ err: err.message }, 'redis sub error (retrying)'));
    /* Standalone ioredis is LAZY and must be told to connect; a Cluster
     * connects eagerly in its constructor and THROWS "Redis is already
     * connecting/connected" if you call connect() as well.
     *
     * `createRedis` returns whichever the URL implies, so this branch is the
     * difference between local dev (standalone, needs the call) and
     * ElastiCache in cluster mode (already connecting, must not be called).
     * Without it the gateway dies at boot on AWS only — the failure cannot
     * reproduce locally, which is what makes it expensive to find. Waiting on
     * 'ready' keeps the original guarantee that the adapter is not installed
     * before both clients can actually carry traffic. */
    const ready = (c: NonNullable<typeof pubClient>) =>
      c.status === 'ready'
        ? Promise.resolve()
        : c.status === 'connecting' || c.status === 'connect' || c.status === 'reconnecting'
          ? new Promise<void>((res, rej) => {
              c.once('ready', () => res());
              c.once('error', rej);
            })
          : c.connect();
    await Promise.all([ready(pubClient!), ready(subClient!)]);
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

  // Shared presence for auto-assignment. Reuses the adapter's pub client rather
  // than opening a third connection — it is a plain key/sorted-set writer, and
  // the pub client is not blocked on a subscription the way the sub client is.
  const presenceStore = pubClient ? createPresenceStore(pubClient) : undefined;

  registerConnection({
    io,
    directus,
    directusUrl: config.DIRECTUS_INTERNAL_URL,
    verifier,
    presenceStore,
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
  /*
   * The walk-in endpoint is called from the customer-facing QR page, which
   * lives on the WIDGET's origin — so it is allow-listed against
   * WIDGET_CORS_ORIGIN, the same list the widget's socket connection uses, and
   * NOT against CORS_ORIGIN, which names the staff portals.
   */
  const allowWidgetOrigin = (originHeader: string | string[] | undefined): string | null => {
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (widgetCorsOrigin === '*') return '*';
    return origin && widgetCorsOrigin.includes(origin) ? origin : null;
  };
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/walk-in/')) return;
    const allow = allowWidgetOrigin(req.headers.origin);
    if (allow) {
      reply.header('Access-Control-Allow-Origin', allow);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'content-type');
      reply.header('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });
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
    if (req.url.startsWith('/jobs/') || req.url.startsWith('/walk-in/'))
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
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
  // Assignment notifications are triggered by working agents, so that endpoint
  // also accepts the Agent role (service accounts, which have no app access, are
  // still excluded — they must not be able to drive user-facing notifications).
  const STAFF_ROLES = new Set([...ADMIN_ROLES, 'Agent']);
  const bearerToken = (req: FastifyRequest): string => {
    const raw = req.headers['authorization'];
    const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  };
  /** Verify the caller's Directus token resolves to one of `roles`. */
  const requireRole = async (
    req: FastifyRequest,
    reply: FastifyReply,
    roles: Set<string>,
    denial: string,
  ): Promise<{ id: string; role: string | null } | null> => {
    const token = bearerToken(req);
    if (!token) {
      await reply.code(401).send({ ok: false, error: 'missing bearer token' });
      return null;
    }
    const identity = await validateAgentToken(config.DIRECTUS_INTERNAL_URL, token);
    if (!identity || !identity.role || !roles.has(identity.role)) {
      await reply.code(403).send({ ok: false, error: denial });
      return null;
    }
    return identity;
  };
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> =>
    (await requireRole(req, reply, ADMIN_ROLES, 'admin role required')) !== null;
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
  /**
   * Admin-triggered: "this coupon is approved — tell Yiji."
   *
   * Admin-only, and the body carries only an id: the worker re-reads the
   * approval with its own service token and refuses anything not actually
   * approved, so this endpoint cannot be used to push a coupon nobody granted
   * or to send terms other than the ones on record.
   */
  app.post('/jobs/coupon-push', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const parsed = CouponPushJob.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ ok: false, error: 'invalid coupon push payload' });
    const jobId = await producer.enqueueCouponPush(parsed.data);
    if (jobId === null)
      return reply.code(503).send({ ok: false, error: 'queue disabled (no Redis)' });
    logger.info({ jobId, couponApprovalId: parsed.data.couponApprovalId }, 'coupon push enqueued');
    return reply.send({ ok: true, jobId });
  });
  // Agent-triggered: "I just assigned this conversation/ticket — tell the
  // assignee." Any staff member may call this, so the body carries NO recipient,
  // title or body (that would be a spam/phishing vector). The client may only
  // name an entity; the gateway re-reads that entity with its SERVICE token and
  // derives the recipient (its current assigned_agent) and the copy itself.
  // Self-assignment and unassigned entities enqueue nothing.
  app.post('/jobs/notify-assignment', async (req, reply) => {
    const identity = await requireRole(req, reply, STAFF_ROLES, 'agent role required');
    if (!identity) return reply;
    const outcome = await notifyAssignment(
      {
        loadEntity: (type, id) => directus.getAssignmentTarget(type, id),
        enqueueNotification: (job, jobId) => producer.enqueueNotification(job, jobId),
        logger,
      },
      req.body,
      identity.id,
    );
    if (outcome.status === 'invalid')
      return reply.code(400).send({ ok: false, error: outcome.error });
    if (outcome.status === 'queue-disabled')
      return reply.code(503).send({ ok: false, error: 'queue disabled (no Redis)' });
    // Skipped cases (missing entity / unassigned / self-assign) answer exactly
    // like a successful no-op: the caller learns nothing about entities it may
    // not read, and the portal treats this as fire-and-forget anyway.
    if (outcome.status === 'skipped') return reply.send({ ok: true, enqueued: false });
    return reply.send({ ok: true, enqueued: true, jobId: outcome.jobId });
  });

  /**
   * "Who on this team should take a handed-over chat?"
   *
   * Answered here rather than in the portal because the answer needs to see
   * other agents' open conversations, which the Agent role deliberately cannot.
   * The portal's own version silently measured everyone as zero and handed the
   * backlog to the lowest uuid. See DirectusGateway.leastLoadedAgentInTeam.
   *
   * Only the chosen id is returned — never the conversations it was counted
   * from — so this leaks nothing the caller could not already ask for.
   */
  app.get('/teams/:teamId/least-loaded', async (req, reply) => {
    const identity = await requireRole(req, reply, STAFF_ROLES, 'agent role required');
    if (!identity) return reply;
    const { teamId } = req.params as { teamId?: string };
    if (!teamId) return reply.code(400).send({ ok: false, error: 'teamId required' });
    try {
      const agentId = await directus.leastLoadedAgentInTeam(teamId);
      return reply.send({ ok: true, agentId });
    } catch (err) {
      logger.warn({ err, teamId }, 'least-loaded lookup failed');
      return reply.code(503).send({ ok: false, error: 'lookup failed' });
    }
  });

  // Diagnostic: inspect which agents the gateway thinks are currently
  // online (and how many sockets each is holding). Useful for chasing the
  // "host page shows online after logout" class of bugs — if this returns
  // distinctOnline > 0 right after you signed out, the gateway is the
  // source of truth saying you're still online, and the offending sockets
  // are listed in `agents`.
  /**
   * WALK-IN SESSION — the store QR code.
   *
   * A customer standing in a branch scans a printed code, types their phone
   * number, and is handed a widget token. The token is minted HERE, server
   * side, because it is signed with YIJI_JWT_SECRET — the same secret that
   * authenticates every in-app customer. Shipping that secret to a public page
   * so the browser could sign its own token would let anyone mint a token for
   * any customer, which is the whole game.
   *
   * The phone is NOT verified, and the design accepts that rather than hiding
   * it. What it buys: no SMS provider, no code to retype at a counter, no
   * failed delivery on a weak signal. What it costs is bounded deliberately —
   * the token carries `walk_in`, which gives the session a conversation of its
   * own and replays no history, so a guessed number cannot read a stranger's
   * chat. Compensation is unaffected because it was never self-service: an
   * agent raises it and a supervisor approves it, and both can see the internal
   * note this session opens with.
   *
   * Rate limited per IP. A phone number is six-ish digits of entropy in
   * practice; without a limit this endpoint is an enumeration tool.
   */
  const walkInBuckets = new Map<string, ReturnType<typeof createTokenBucket>>();
  app.post('/walk-in/session', async (req, reply) => {
    const ip = req.ip || 'unknown';
    let bucket = walkInBuckets.get(ip);
    if (!bucket) {
      // 5 immediately, then one every 30s. A real customer needs one.
      bucket = createTokenBucket(5, 1 / 30);
      walkInBuckets.set(ip, bucket);
    }
    if (!bucket.tryRemove()) {
      return reply.code(429).send({ ok: false, error: 'too many attempts, try again shortly' });
    }

    /*
     * TWO WAYS IN, one of which the customer did not type.
     *
     * A personal link carries a short CODE, and the number it stands for is
     * looked up here. That is what stops the link being edited into somebody
     * else's chat: `?phone=05…` would be guessable across a keyspace of eight
     * digits, while a code is ten Crockford base32 characters and means
     * nothing without the row behind it.
     *
     * The lookup also owns expiry and revocation, so a link can be killed by
     * deleting a row — which a signed token could never offer.
     */
    const asCode = WalkInCodeRequest.safeParse(req.body);
    let phone: string;
    let vendorId: string;
    if (asCode.success) {
      const link = await directus.resolveWalkInLink(asCode.data.code).catch(() => null);
      if (!link) {
        // Unknown, expired or revoked — one message for all three, because
        // telling a caller WHICH is telling them their guess had the right
        // shape.
        return reply.code(401).send({ ok: false, error: 'this link is no longer valid' });
      }
      phone = link.phone;
      vendorId = link.vendorId;
    } else {
      const parsed = WalkInSessionRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'a valid phone number is required' });
      }
      phone = parsed.data.phone;
      vendorId = parsed.data.vendorId;
    }

    const vendor = await directus.resolveVendor(vendorId).catch(() => null);
    if (!vendor) return reply.code(404).send({ ok: false, error: 'unknown or inactive vendor' });

    /*
     * NORMALISE before anything is derived from it.
     *
     * Contacts are matched by exact phone equality, and the Yiji app sends
     * `+9665XXXXXXXX` while somebody at a counter types `05XXXXXXXX`. Signing
     * the raw string produced a SECOND contact for a customer who already
     * existed — so a registered customer arriving by QR code got no order
     * history, which defeats the point of asking for the number. Caught by
     * reading the contacts table after a walk-in, not from the code.
     */
    const normalized = normalizePhone(phone);
    const token = jwt.sign(
      {
        vendor_id: vendorId,
        customer_id: phoneCustomerId(normalized),
        phone: normalized,
        walk_in: true,
      },
      config.YIJI_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '2h' },
    );

    logger.info({ vendorId, walkIn: true }, 'walk-in session issued');
    return reply.send({ ok: true, token });
  });

  /**
   * Mint a personal walk-in link for one customer. ADMIN ONLY.
   *
   * The link auto-starts a chat, so minting one is handing out a session for a
   * number nobody proved. That is acceptable when an operator does it
   * deliberately for a customer they are already talking to, and unacceptable
   * as something the internet can do — hence the admin guard, which is the only
   * reason this is not simply a public endpoint taking a phone number.
   *
   * The response is a URL carrying a SIGNED TOKEN, never the number itself.
   * See `WalkInLinkClaims` for the two reasons that matters.
   */
  app.post('/walk-in/link', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const parsed = WalkInLinkRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'a valid phone number is required' });
    }
    const { phone, vendorId } = parsed.data;
    const days = parsed.data.days ?? 7;

    const vendor = await directus.resolveVendor(vendorId).catch(() => null);
    if (!vendor) return reply.code(404).send({ ok: false, error: 'unknown or inactive vendor' });

    // Normalised before storing, so the link and a typed-in session resolve to
    // exactly the same contact rather than two spellings of one customer.
    const normalized = normalizePhone(phone);
    const code = walkInCode();
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    await directus.createWalkInLink({
      code,
      phone: normalized,
      vendorUuid: vendor.id,
      expiresAt,
      createdBy: null,
    });
    logger.info({ vendorId, days, code }, 'walk-in link minted');
    return reply.send({
      ok: true,
      code,
      expiresAt,
      /* The path is the caller's to assemble — the gateway does not know which
         public host the widget is served from, and guessing would produce a
         link that works from our network and nowhere else. */
      path: `/walk-in.html?c=${code}`,
    });
  });

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
