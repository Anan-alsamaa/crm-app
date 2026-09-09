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

/**
 * The tenant a token belongs to when it does not name one.
 *
 * `vendor_id` is a CRM-internal identifier: the Yiji app has no reason to know
 * it, and asking an integrator to hardcode "1" in their signing code invites
 * exactly one question — "what is vendor 2?" — with no useful answer. There is
 * one vendor today, so the gateway supplies it and a token that DOES name one
 * still wins, which keeps the door open for a second tenant without a
 * migration.
 */
/* Exported so the walk-in endpoint defaults to the SAME vendor this verifier
   assumes. Two copies of "1" would drift the moment one of them changed. */
export const DEFAULT_VENDOR_ID = process.env.DEFAULT_VENDOR_ID?.trim() || '1';

export const CustomerClaims = z.object({
  vendor_id: z.preprocess((v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || DEFAULT_VENDOR_ID;
  }, z.string().min(1)),
  /**
   * Who this is, in Yiji's own numbering.
   *
   * Still required for an app token: it is what the agent's order lookup uses,
   * and a chat that cannot show a customer's orders is most of the product
   * missing. The walk-in endpoint mints its own from the phone number, which
   * is why this is never optional here.
   */
  customer_id: z.string().min(1),
  // Phone is the ONLY mandatory contact identifier. null/absent normalize to
  // undefined; an empty/whitespace string is left to fail the explicit check in
  // verify() (so the error is clear).
  phone: z.preprocess((v) => (v == null ? undefined : v), z.string().optional()),
  // Name + email are optional and may be absent, null, or empty.
  name: z.preprocess(blankToUndefined, z.string().optional()),
  email: z.preprocess(blankToUndefined, z.string().email().optional()),
  /**
   * Minted by the WALK-IN endpoint rather than handed over by the Yiji app.
   *
   * The customer typed a phone number into a page reached from a QR code in a
   * store; nobody proved the number is theirs. The session is therefore given
   * a conversation of its own and no history — see `findOrCreateConversation`
   * vs `createConversation` at the call site — so an unverified visitor can
   * never read a stranger's past chat by guessing their number.
   *
   * Absent on the ordinary in-app token, which the Yiji platform signs for a
   * customer it has already authenticated.
   */
  walk_in: z.boolean().optional(),
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
