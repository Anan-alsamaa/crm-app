import jwt from 'jsonwebtoken';
import { z } from 'zod';

/**
 * Customer (widget) token verification (spec Section 9, research D-02).
 * HS256 with a shared secret for the initial release; the verifier is wrapped
 * so moving to RS256 (public key) is a one-place change. Signature, expiry,
 * and identity-field sanity are all checked. Query params are never trusted.
 */

export const CustomerClaims = z.object({
  vendor_id: z.string().min(1),
  customer_id: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
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
      // At least one USABLE contact identifier is required to dedup a contact.
      // Trim so a blank/whitespace phone or email doesn't count as present
      // (name is intentionally optional — the host may omit it or send a dummy).
      if (!parsed.data.phone?.trim() && !parsed.data.email?.trim()) {
        throw new CustomerTokenError('token must include phone or email');
      }
      return parsed.data;
    },
  };
}
