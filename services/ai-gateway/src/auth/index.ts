import type { FastifyRequest } from 'fastify';

/**
 * Caller authentication for the AI gateway.
 *
 * The caller (agent/admin portal) sends its own short-lived **Directus access
 * token** as `Authorization: Bearer <token>`. The gateway VERIFIES that token
 * against Directus server-side and derives identity from the result:
 *   - userId  — the authenticated Directus user id (rate-limit + audit scope)
 *   - isAdmin — whether that user's role is an admin role (from Directus, NOT a
 *               client-supplied header)
 *
 * This replaces the previous design where the browser shipped a static service
 * token and asserted its own identity/role via X-Yiji-* headers — anyone who
 * extracted the bundled token could call every endpoint and self-grant admin.
 *
 * `X-Yiji-Vendor` is still read, but ONLY as a FALLBACK cost bucket (a
 * cost-accounting hint, not an access-control boundary): a verified agent may
 * act on any conversation in the shared inbox. Since MV-4 every endpoint that
 * names a conversation re-scopes the caller to THAT conversation's vendor, read
 * from the database (`scopeCallerToVendor`), so the monthly-cap bucket, the
 * per-vendor AI config and the search scope follow the data, not the header.
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

/** Minimal Directus surface the verifier needs (so it is easy to unit-test). */
export interface CallerVerifierDeps {
  /** Resolve a Directus access token to its user id + role id, or null if invalid. */
  whoAmI(token: string): Promise<{ id: string; role: string | null } | null>;
  /** The set of Directus role ids that count as admin (cached by the impl). */
  adminRoleIds(): Promise<Set<string>>;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1]?.trim() ?? null;
}

/**
 * Verify the caller's Directus session and build a trusted Caller. Throws
 * AuthError (401) on a missing/invalid token.
 */
export async function verifyCaller(req: FastifyRequest, deps: CallerVerifierDeps): Promise<Caller> {
  const token = bearerToken(req);
  if (!token) throw new AuthError('Missing bearer token', 401);

  const who = await deps.whoAmI(token);
  if (!who) throw new AuthError('Invalid or expired session', 401);

  const isAdmin = who.role ? (await deps.adminRoleIds()).has(who.role) : false;
  const vendorId = (req.headers['x-yiji-vendor'] as string | undefined) ?? '';
  return { userId: who.id, vendorId, isAdmin };
}

/**
 * The caller, re-scoped to the vendor of the conversation being worked on
 * (MV-4, EMA-73). The conversation's vendor comes from the database and wins
 * over the client header; a conversation with no vendor recorded keeps the
 * header's bucket, which is what every request did before.
 */
export function scopeCallerToVendor(
  caller: Caller,
  conversationVendor: string | { id?: string | null } | null | undefined,
): Caller {
  const v =
    typeof conversationVendor === 'string' ? conversationVendor : (conversationVendor?.id ?? '');
  return v ? { ...caller, vendorId: v } : caller;
}
