/**
 * socket-gateway entrypoint (US2).
 *
 * Stateless Socket.IO server. When REDIS_ENABLED, uses the Redis adapter for
 * cross-instance fanout (horizontal scaling, SC-010) + BullMQ side-effect jobs.
 * When disabled, runs a single in-memory instance so it works locally without
 * Redis. Fastify serves /health + /ready; pino logging; graceful shutdown.
 */
import { createServer } from 'node:http';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import pino from 'pino';
import { loadConfig } from './config.js';
import { GatewayDirectus } from './directus.js';
import { createHs256Verifier } from './auth/customer-jwt.js';
import { createProducer } from './queue.js';
import { registerConnection, getAgentPresenceSnapshot } from './connection.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: 'socket-gateway' });

  const httpServer = createServer();
  const io = new SocketServer(httpServer, { cors: { origin: config.CORS_ORIGIN } });

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
  });

  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    if (config.REDIS_ENABLED && pubClient?.status !== 'ready') {
      return reply.code(503).send({ status: 'not-ready', redis: pubClient?.status });
    }
    return { status: 'ready' };
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
  logger.info(`health endpoints on :${config.PORT + 1}`);

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
