import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Logger } from 'pino';
import { resolveCustomerClaims } from '../src/connection.js';
import { createHs256Verifier, CustomerTokenError } from '../src/auth/customer-jwt.js';

/**
 * Opening the chat from inside the Yiji app.
 *
 * THE BUG THIS EXISTS FOR. The app forwards its OWN session token — `iss:
 * SecureApi`, signed with Yiji's secret, carrying a user `Id` and no phone
 * number. The gateway could neither verify that signature nor read a phone out
 * of it, so it refused every one: twelve `token invalid: invalid signature` in
 * the production log, and a customer looking at "Connecting…" for ever.
 *
 * The fix is not to trust their token. It is to stop needing to: take the id,
 * look the customer up through Yiji's admin API with OUR service credential,
 * and build claims from what comes back. The app changes nothing and no secret
 * is shared.
 */
const SECRET = 'a-test-secret-that-is-long-enough-for-the-gateway';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

/** A token shaped exactly like the ones the Yiji app sends. */
const yijiToken = (over: Record<string, unknown> = {}) =>
  jwt.sign(
    {
      Id: 'cd32f3aa-fbaa-438c-abfb-1c122a6f3130',
      'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': ['CLIENT'],
      Brand: '0',
      Restaurant: '0',
      iss: 'SecureApi',
      ...over,
    },
    'yijis-own-secret-which-we-do-not-have',
    { algorithm: 'HS256', expiresIn: '1h' },
  );

const reader = (profile: unknown) => vi.fn(async () => profile as never);

describe('a session opened from the Yiji app', () => {
  const verifier = createHs256Verifier(SECRET);

  it('resolves the customer by looking their id up in Yiji', async () => {
    const yijiUsers = reader({
      id: 'cd32f3aa-fbaa-438c-abfb-1c122a6f3130',
      phone: '+966515553891',
      name: 'Test orders',
      email: 'testDriver1@yahoo.com',
    });

    const claims = await resolveCustomerClaims(yijiToken(), verifier, yijiUsers, logger);

    expect(yijiUsers).toHaveBeenCalledWith('cd32f3aa-fbaa-438c-abfb-1c122a6f3130');
    /*
     * `05…`, NOT the `+9665…` Yiji returns.
     *
     * Contacts are matched by exact phone equality and every stored number is
     * `05…`, so keeping E.164 here creates a second contact for a customer who
     * already exists and loses their order history. Found by reading the
     * contacts table after the first end-to-end run: the row came back as
     * `+966515553891` beside a table of `05…` numbers.
     */
    expect(claims.phone).toBe('0515553891');
    // The REAL Yiji id, not a phone-derived handle: this becomes
    // `external_customer_id`, which the coupon push sends to Yiji as `userId`.
    expect(claims.customer_id).toBe('cd32f3aa-fbaa-438c-abfb-1c122a6f3130');
    expect(claims.name).toBe('Test orders');
    /* NOT a walk-in: they came through the app and Yiji's own lookup confirmed
       the id. Drives `acquisition_channel: 'app'` and lets the session resume
       their existing thread. */
    expect(claims.walk_in).toBe(false);
  });

  it('still prefers OUR token, and never calls Yiji for one', async () => {
    // The common path must cost nothing: a token we minted is verified locally.
    const yijiUsers = reader(null);
    const ours = jwt.sign({ customer_id: 'c1', phone: '0500000001' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });

    const claims = await resolveCustomerClaims(ours, verifier, yijiUsers, logger);

    expect(claims.customer_id).toBe('c1');
    expect(yijiUsers).not.toHaveBeenCalled();
  });

  it('refuses when Yiji does not know the id', async () => {
    // A forged or stale id resolves to nobody, and that is a refusal — not a
    // session for an invented customer.
    const yijiUsers = reader(null);
    await expect(resolveCustomerClaims(yijiToken(), verifier, yijiUsers, logger)).rejects.toThrow(
      CustomerTokenError,
    );
  });

  it('refuses when the lookup is not configured at all', async () => {
    // Null reader = no Yiji credential in this environment. The foreign token
    // is refused exactly as it was before this feature existed.
    await expect(resolveCustomerClaims(yijiToken(), verifier, null, logger)).rejects.toThrow(
      /invalid signature/i,
    );
  });

  it('honours THEIR expiry even though it cannot verify their signature', async () => {
    // An expired session is expired whoever issued it. Checking `exp` costs one
    // comparison and stops a stale token being replayed for ever.
    const yijiUsers = reader({ id: 'x', phone: '+966500000001' });
    const expired = jwt.sign({ Id: 'x', iss: 'SecureApi' }, 'theirs', {
      algorithm: 'HS256',
      expiresIn: '-1h',
    });

    await expect(resolveCustomerClaims(expired, verifier, yijiUsers, logger)).rejects.toThrow(
      /expired/i,
    );
    expect(yijiUsers).not.toHaveBeenCalled();
  });

  it('does not re-read a MALFORMED token as a Yiji id', async () => {
    // Only a signature failure is worth a second look. Re-reading a malformed
    // token would replace a precise message with a vague one.
    const yijiUsers = reader({ id: 'x', phone: '+966500000001' });
    await expect(resolveCustomerClaims('not-a-jwt', verifier, yijiUsers, logger)).rejects.toThrow(
      /malformed/i,
    );
    expect(yijiUsers).not.toHaveBeenCalled();
  });

  it('reports Yiji being down as a refusal, not as a bad token', async () => {
    // The customer sees a refusal either way, but the LOG must distinguish
    // "your token is wrong" from "the upstream is unreachable" — those need
    // opposite responses from whoever reads it.
    const yijiUsers = vi.fn(async () => {
      throw new Error('upstream timed out');
    });
    await expect(
      resolveCustomerClaims(yijiToken(), verifier, yijiUsers as never, logger),
    ).rejects.toThrow(CustomerTokenError);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('refuses a Yiji profile that carries no phone', async () => {
    // Phone is how contacts are matched. A profile without one would open a
    // contact that can never be matched to the same person again.
    const yijiUsers = reader(null); // the reader returns null for exactly this
    await expect(resolveCustomerClaims(yijiToken(), verifier, yijiUsers, logger)).rejects.toThrow(
      CustomerTokenError,
    );
  });
});
