import type { FastifyRequest } from 'fastify';

/**
 * Service-token auth.
 *
 * Callers (agent portal, workers) send `Authorization: Bearer <SVC_AI_TOKEN>`.
 * Identity is passed via headers we set ourselves on the trusted client side:
 *   - X-Yiji-User: directus user id (string)  — for per-user rate limits
 *   - X-Yiji-Vendor: vendor id (string)        — for monthly cap scope
 *
 * Admin-config endpoints require an extra `X-Yiji-Admin: 1` header. The
 * portal sets this only after Directus has confirmed the caller has the
 * Administrator role.
 */

export interface Caller {
  userId: string;
  vendorId: string;
  isAdmin: boolean;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function authenticate(req: FastifyRequest, expectedToken: string): Caller {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || m[1] !== expectedToken) {
    throw new AuthError('Invalid or missing service token', 401);
  }
  const userId = (req.headers['x-yiji-user'] as string | undefined) ?? '';
  const vendorId = (req.headers['x-yiji-vendor'] as string | undefined) ?? '';
  if (!userId || !vendorId) {
    throw new AuthError('Missing X-Yiji-User or X-Yiji-Vendor header', 400);
  }
  const isAdmin = req.headers['x-yiji-admin'] === '1';
  return { userId, vendorId, isAdmin };
}
