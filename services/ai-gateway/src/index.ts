/**
 * ai-gateway entrypoint (skeleton — T022).
 *
 * Fastify HTTP service exposing /health, /ready, and the 7 AI endpoint stubs.
 * PII redaction, the Gemini provider, rate limiting, and caching are added in
 * Phase 7 (US5).
 */
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadConfig } from './config.js';
import { registerAiRoutes } from './routes.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: 'ai-gateway' });
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true });
  await redis.connect();

  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    if (redis.status !== 'ready')
      return reply.code(503).send({ status: 'not-ready', redis: redis.status });
    return { status: 'ready' };
  });
  await registerAiRoutes(app);

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
