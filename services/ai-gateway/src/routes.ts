import type { FastifyInstance } from 'fastify';
import { AI_ENDPOINTS } from '@yiji/shared-types';

/**
 * AI endpoint route stubs (skeleton — T022). Each endpoint is implemented in
 * Phase 7 (US5): fetch Directus context → redact PII → call provider →
 * rate-limit/cache. Until then they return 501 Not Implemented.
 */
export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  const endpoints = Object.values(AI_ENDPOINTS);
  for (const path of endpoints) {
    app.post(path, async (_req, reply) =>
      reply.code(501).send({ error: 'not_implemented', endpoint: path }),
    );
  }
}
