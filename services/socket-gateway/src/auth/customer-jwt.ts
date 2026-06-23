import jwt from 'jsonwebtoken';
import { z } from 'zod';

/**
 * Customer (widget) token verification (spec Section 9, research D-02).
 * HS256 with a shared secret for the initial release; the verifier is wrapped
 * so moving to RS256 (public key) is a one-place change. Signature, expiry,
 * and identity-field sanity are all checked. Query params are never trusted.
 */

/**
 * The host may send an optional field as absent, JSON null, or an empty/whitespace
 * string — normalize all of those to "absent" so they never fail validation.
 */
const blankToUndefined = (v: unknown): unknown =>
  v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v;

export const CustomerClaims = z.object({
  vendor_id: z.string().min(1),
  customer_id: z.string().min(1),
  // Phone is the ONLY mandatory contact identifier. null/absent normalize to
  // undefined; an empty/whitespace string is left to fail the explicit check in
  // verify() (so the error is clear).
  phone: z.preprocess((v) => (v == null ? undefined : v), z.string().optional()),
  // Name + email are optional and may be absent, null, or empty.
  name: z.preprocess(blankToUndefined, z.string().optional()),
  email: z.preprocess(blankToUndefined, z.string().email().optional()),
  iat: z.number().optional(),
  exp: z.number().optional(),
});
export type CustomerClaims = z.infer<typeof CustomerClaims>;

export class CustomerTokenError extends Error {}

export interface CustomerVerifier {
  verify(token: string): CustomerClaims;
}

/** HS256 shared-secret verifier (default). */
export function createHs256Verifier(secret: string): CustomerVerifier {
  return {
    verify(token: string): CustomerClaims {
      let decoded: unknown;
      try {
        decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
      } catch (err) {
        throw new CustomerTokenError(
          err instanceof Error ? `token invalid: ${err.message}` : 'token invalid',
        );
      }
      const parsed = CustomerClaims.safeParse(decoded);
      if (!parsed.success) {
        throw new CustomerTokenError('token payload missing required identity fields');
      }
      // Phone is the ONLY mandatory contact identifier — the host guarantees it.
      // Name + email are optional (absent/null/empty are normalized to undefined
      // above). A blank/whitespace-only phone is treated as missing.
      if (!parsed.data.phone?.trim()) {
        throw new CustomerTokenError('token must include a phone number');
      }
      return parsed.data;
    },
  };
}
