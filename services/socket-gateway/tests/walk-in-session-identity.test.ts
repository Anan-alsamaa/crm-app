import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Logger } from 'pino';
import { resolveCustomerClaims } from '../src/connection.js';
import { createHs256Verifier } from '../src/auth/customer-jwt.js';

/**
 * Opening the chat from the Yiji app WITHOUT a token in the URL.
 *
 * The app used to navigate a web view to `…/?token=<JWT>`. The widget stripped
 * it from the address bar on arrival, but by then a 2-hour credential carrying
 * the customer's phone and id had already been written to web-view history,
 * sent as a `Referer`, and captured by any screenshot. It now POSTs to
 * `/walk-in/session` instead, where nothing lands in a URL.
 *
 * That move creates a NEW risk, which is what these cover. `customerId` in a
 * request body decides `walk_in`, and `walk_in: false` replays previous
 * conversations — so believing a self-asserted id would let anyone who guessed
 * a phone number read another customer's history over plain HTTP. The endpoint
 * therefore resolves the app's own session token through Yiji instead of
 * trusting anything the caller says about itself.
 *
 * These exercise `resolveCustomerClaims`, which is the function the endpoint
 * delegates that decision to.
 */
const SECRET = 'a-test-secret-that-is-long-enough-for-the-gateway';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const verifier = createHs256Verifier(SECRET);

/** A token shaped exactly like the ones the Yiji app sends. */
const appToken = (over: Record<string, unknown> = {}) =>
  jwt.sign(
    { Id: 'cd32f3aa-fbaa-438c-abfb-1c122a6f3130', iss: 'SecureApi', ...over },
    'yijis-own-secret-which-we-do-not-have',
    { algorithm: 'HS256', expiresIn: '1h' },
  );

describe('identifying an in-app customer without a token in the URL', () => {
  it('resolves the customer through Yiji and marks the session NOT a walk-in', async () => {
    const yijiUsers = vi.fn(async () => ({
      id: 'yiji-real-id',
      phone: '+966512345678',
      name: 'Imad',
      email: 'imad@example.com',
    })) as never;

    const claims = await resolveCustomerClaims(appToken(), verifier, yijiUsers, logger);

    expect(claims.customer_id).toBe('yiji-real-id');
    // `05…`, never the `+9665…` Yiji returns: contacts match on exact phone
    // equality, so the other spelling silently creates a second contact and
    // loses the customer's order history.
    expect(claims.phone).toBe('0512345678');
    expect(claims.walk_in).toBe(false);
  });

  it('carries the optional name and email when Yiji knows them', async () => {
    const yijiUsers = vi.fn(async () => ({
      id: 'yiji-real-id',
      phone: '+966512345678',
      name: 'Imad',
      email: 'imad@example.com',
    })) as never;
    const claims = await resolveCustomerClaims(appToken(), verifier, yijiUsers, logger);
    expect(claims.name).toBe('Imad');
    expect(claims.email).toBe('imad@example.com');
  });

  it('still identifies the customer when Yiji has no name or email', async () => {
    // Phone is the only mandatory identity. A customer with a bare account must
    // still reach an agent.
    const yijiUsers = vi.fn(async () => ({
      id: 'yiji-real-id',
      phone: '+966512345678',
      name: null,
      email: null,
    })) as never;
    const claims = await resolveCustomerClaims(appToken(), verifier, yijiUsers, logger);
    expect(claims.customer_id).toBe('yiji-real-id');
    expect(claims.phone).toBe('0512345678');
  });

  it('REFUSES to identify anybody when the id resolves to nothing', async () => {
    /*
     * The impersonation guard. A forged token names an id that Yiji does not
     * know; the lookup returns null and this must not produce claims at all.
     * The endpoint catches the throw and degrades the session to a walk-in —
     * no history replay, no real external id — rather than handing the caller
     * somebody else's identity.
     */
    const yijiUsers = vi.fn(async () => null) as never;
    await expect(
      resolveCustomerClaims(
        appToken({ Id: 'an-id-yiji-never-issued' }),
        verifier,
        yijiUsers,
        logger,
      ),
    ).rejects.toThrow();
  });

  it('refuses an expired app session even though we cannot verify its signature', async () => {
    const yijiUsers = vi.fn(async () => ({ id: 'x', phone: '+966512345678' })) as never;
    const expired = jwt.sign(
      { Id: 'someone', iss: 'SecureApi', exp: Math.floor(Date.now() / 1000) - 60 },
      'yijis-own-secret-which-we-do-not-have',
      { algorithm: 'HS256' },
    );
    await expect(resolveCustomerClaims(expired, verifier, yijiUsers, logger)).rejects.toThrow();
    // Never looked up: an expired session is expired whoever issued it.
    expect(yijiUsers).not.toHaveBeenCalled();
  });

  it('does not call Yiji at all for a token we signed ourselves', async () => {
    // Our own token verifies on the first attempt, so the upstream lookup — and
    // its latency — is skipped entirely.
    const ours = jwt.sign({ vendor_id: '1', customer_id: 'cust-1', phone: '0512345678' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    const yijiUsers = vi.fn(async () => null) as never;
    const claims = await resolveCustomerClaims(ours, verifier, yijiUsers, logger);
    expect(claims.customer_id).toBe('cust-1');
    expect(yijiUsers).not.toHaveBeenCalled();
  });
});
