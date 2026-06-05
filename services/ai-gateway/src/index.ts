/**
 * ai-gateway entrypoint.
 *
 * Fastify HTTP service exposing /health, /ready, /metrics, the 7 AI endpoints,
 * and /admin/config + /admin/usage. PII redaction runs on every outbound call.
 */
import './telemetry.js'; // MUST be first: starts OTel before http/ioredis load.
import Fastify, { type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadConfig } from './config.js';
import { registerAiRoutes } from './routes.js';
import { GeminiProvider } from './provider/gemini.js';
import { AiConfigStore } from './aiconfig/index.js';
import { SlidingWindowLimiter, MonthlyCap } from './ratelimit/index.js';
import { ResponseCache } from './cache/index.js';
import { GatewayDirectus } from './directus/index.js';
import { Registry } from './metrics.js';
import type { AIProvider } from './provider/types.js';

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

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: 'ai-gateway' });
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true });
  await redis.connect();

  // Provider — Gemini only per current direction. If GEMINI_API_KEY is
  // missing we install a stub that surfaces 503 on every endpoint rather
  // than crashing on boot, so the rest of the service stays healthy.
  let provider: AIProvider;
  try {
    provider = new GeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL);
    logger.info({ model: config.GEMINI_MODEL }, 'gemini provider ready');
  } catch (err) {
    logger.warn({ err }, 'gemini provider not configured — endpoints will 503');
    provider = {
      name: 'gemini',
      async run() {
        throw err;
      },
    };
  }

  const directus = new GatewayDirectus(
    config.DIRECTUS_INTERNAL_URL,
    config.DIRECTUS_AI_TOKEN || config.SVC_AI_TOKEN,
  );
  const configStore = new AiConfigStore(redis);
  const cache = new ResponseCache(redis, config.AI_CACHE_TTL_SEC);
  const perUserLimiter = new SlidingWindowLimiter(redis, 60_000, config.AI_PER_USER_RPM, 'rl:user');
  const perIpLimiter = new SlidingWindowLimiter(redis, 60_000, config.AI_PER_IP_RPM, 'rl:ip');
  const globalLimiter = new SlidingWindowLimiter(redis, 60_000, config.AI_GLOBAL_RPM, 'rl:global');
  const monthlyCap = new MonthlyCap(redis);

  // --- Metrics ---
  const metrics = new Registry();
  metrics.collectDefaultMetrics('ai-gateway');
  const httpRequests = metrics.counter('http_requests_total', 'HTTP requests handled.');
  const httpLatency = metrics.histogram(
    'http_request_duration_seconds',
    'HTTP request latency in seconds.',
  );

  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  // CORS allow-list — comma-separated origins or `*` (dev only).
  const corsOrigins =
    config.CORS_ORIGIN === '*'
      ? true
      : config.CORS_ORIGIN.split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  await app.register(cors, { origin: corsOrigins, credentials: true });

  // Hardening headers on every response (TLS terminates at the LB/proxy).
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.removeHeader('X-Powered-By');
    return payload;
  });

  // Per-request metrics. /metrics itself is excluded to avoid self-counting.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unknown';
    if (route === '/metrics') return;
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    httpRequests.inc(labels);
    httpLatency.observe(reply.elapsedTime / 1000, { method: req.method, route });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;
    if (redis.status !== 'ready') {
      checks.redis = redis.status;
      ready = false;
    } else {
      try {
        checks.redis = (await redis.ping()) === 'PONG' ? 'ok' : 'unexpected';
        if (checks.redis !== 'ok') ready = false;
      } catch {
        checks.redis = 'unreachable';
        ready = false;
      }
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

  await registerAiRoutes(app, {
    provider,
    directus,
    configStore,
    cache,
    perUserLimiter,
    perIpLimiter,
    globalLimiter,
    monthlyCap,
    serviceToken: config.SVC_AI_TOKEN,
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(`ai-gateway listening on :${config.PORT}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('ai-gateway failed to start:', err);
  process.exit(1);
});
