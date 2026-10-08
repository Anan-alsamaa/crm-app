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

/**
 * The vendor a token CLAIMS, normalised exactly as the schema below does.
 *
 * MV-3: the claim picks the SECRET the token is verified with, so it has to be
 * read before the signature is checked — and read the same way the parsed
 * claims will report it, or a token could be verified as one vendor and served
 * as another.
 *
 * A token with no `vendor_id` (the legacy Yiji app, which never learned our
 * vendor numbering) is the DEFAULT vendor — Yiji. That default applies ONLY to
 * a token that names no vendor; one that names a vendor is held to it.
 */
export function claimedVendorId(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s || DEFAULT_VENDOR_ID;
}

export const CustomerClaims = z.object({
  vendor_id: z.preprocess(claimedVendorId, z.string().min(1)),
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
  /**
   * WHICH DOOR they came through — independent of whether they have an account.
   *
   * `walk_in` above answers "is this identity unproven?". That is not the same
   * question as "where did this person start?", and using one boolean for both
   * lost a case the owner needs (2026-09-13): an app customer STANDING IN A
   * BRANCH proved their account, so `walk_in` was false, so they were recorded
   * as `app` and became indistinguishable from a customer at home.
   *
   * Set only by the QR page's endpoint, which is the one caller that knows the
   * customer is physically in a store. Absent on an in-app token, where the
   * door is implied.
   */
  entry_point: z.enum(['app', 'store_qr']).optional(),
  /* The order this chat is about, when Yiji opened it from order tracking.
     Carried on the token so the conversation records it at creation. */
  order_id: z.string().min(1).max(64).optional(),
  iat: z.number().optional(),
  exp: z.number().optional(),
});
export type CustomerClaims = z.infer<typeof CustomerClaims>;

export class CustomerTokenError extends Error {}

export interface CustomerVerifier {
  verify(token: string): CustomerClaims | Promise<CustomerClaims>;
}

/** HS256 with ONE shared secret — synchronous. */
export interface SyncCustomerVerifier extends CustomerVerifier {
  verify(token: string): CustomerClaims;
}

/** HS256 shared-secret verifier (one vendor's secret). */
export function createHs256Verifier(secret: string): SyncCustomerVerifier {
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

/**
 * PER-VENDOR VERIFIER (MV-3, EMA-72).
 *
 * The token is verified with the secret of the vendor it CLAIMS
 * (`vendor_id`), so a token signed with Yiji's secret that claims vendor B is
 * checked against B's secret and fails — no vendor can open a session as
 * another. A vendor with no configured secret (`secretFor` answers null) is
 * refused outright; there is no fallback to Yiji's secret.
 *
 * The claim is read UNVERIFIED only to choose the key; nothing else from the
 * payload is trusted until the signature has passed. For a Yiji token
 * (`vendor_id` absent or the default) this is the same single HS256 check as
 * before, with the same error messages — `resolveCustomerClaims` relies on the
 * "invalid signature" wording to recognise an app-issued Yiji session token.
 */
export function createVendorVerifier(
  secretFor: (vendorId: string) => Promise<string | null>,
): CustomerVerifier {
  return {
    async verify(token: string): Promise<CustomerClaims> {
      const peeked = jwt.decode(token);
      const vendorId = claimedVendorId(
        peeked && typeof peeked === 'object' ? (peeked as { vendor_id?: unknown }).vendor_id : '',
      );
      let secret: string | null;
      try {
        secret = await secretFor(vendorId);
      } catch {
        throw new CustomerTokenError('token invalid: vendor could not be resolved');
      }
      if (!secret) throw new CustomerTokenError('token invalid: vendor not configured');
      const claims = createHs256Verifier(secret).verify(token);
      /* Belt and braces: the claims are served as the vendor whose key verified them. */
      if (claims.vendor_id !== vendorId)
        throw new CustomerTokenError('token invalid: vendor mismatch');
      return claims;
    },
  };
}
