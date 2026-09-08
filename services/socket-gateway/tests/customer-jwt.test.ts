import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { createHs256Verifier, CustomerTokenError } from '../src/auth/customer-jwt.js';

const SECRET = 'test-secret';
const verifier = createHs256Verifier(SECRET);

function sign(payload: Record<string, unknown>, opts?: jwt.SignOptions): string {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', ...opts });
}

describe('customer JWT verifier (T040)', () => {
  const valid = {
    vendor_id: 'demo-vendor',
    customer_id: 'c1',
    phone: '+966500000001',
    email: 'c@example.com',
    name: 'Test',
  };

  it('accepts a valid token and returns claims', () => {
    const claims = verifier.verify(sign(valid));
    expect(claims.vendor_id).toBe('demo-vendor');
    expect(claims.customer_id).toBe('c1');
  });

  it('rejects a token signed with the wrong secret', () => {
    const bad = jwt.sign(valid, 'wrong-secret', { algorithm: 'HS256' });
    expect(() => verifier.verify(bad)).toThrow(CustomerTokenError);
  });

  it('rejects an expired token', () => {
    const expired = sign(valid, { expiresIn: -10 });
    expect(() => verifier.verify(expired)).toThrow(CustomerTokenError);
  });

  it('rejects a token with no phone — phone is the only mandatory field', () => {
    const { phone: _p, ...rest } = valid; // still has email + name
    expect(() => verifier.verify(sign(rest))).toThrow(/phone/);
  });

  it('rejects a token with email but no phone', () => {
    expect(() =>
      verifier.verify(sign({ vendor_id: 'demo-vendor', customer_id: 'c1', email: 'x@y.com' })),
    ).toThrow(/phone/);
  });

  it('rejects a token missing required identity fields', () => {
    expect(() => verifier.verify(sign({ foo: 'bar' }))).toThrow(CustomerTokenError);
  });

  it('rejects a non-HS256 (alg=none) token', () => {
    const none = jwt.sign(valid, '', { algorithm: 'none' });
    expect(() => verifier.verify(none)).toThrow(CustomerTokenError);
  });

  it('accepts a token with no name — name is optional (host may omit it)', () => {
    const { name: _n, ...noName } = valid;
    const claims = verifier.verify(sign(noName));
    expect(claims.name).toBeUndefined();
    expect(claims.phone).toBe('+966500000001');
    expect(claims.customer_id).toBe('c1');
  });

  it('accepts phone-only (no email, no name) — the guaranteed-field case', () => {
    const claims = verifier.verify(
      sign({ vendor_id: 'demo-vendor', customer_id: 'c1', phone: '+966500000002' }),
    );
    expect(claims.customer_id).toBe('c1');
  });

  it('rejects a blank/whitespace-only phone', () => {
    expect(() =>
      verifier.verify(sign({ vendor_id: 'demo-vendor', customer_id: 'c1', phone: '   ' })),
    ).toThrow(/phone/);
  });

  it('accepts phone with null name and empty email (both optional)', () => {
    const claims = verifier.verify(
      sign({
        vendor_id: 'demo-vendor',
        customer_id: 'c1',
        phone: '+966500000003',
        name: null,
        email: '',
      }),
    );
    expect(claims.phone).toBe('+966500000003');
    expect(claims.name).toBeUndefined();
    expect(claims.email).toBeUndefined();
  });
});

/*
 * vendor_id is CRM-INTERNAL, so the app should not have to send it.
 *
 * Asking an integrator to hardcode "1" in their signing code invites exactly
 * one question — "what is vendor 2?" — with no useful answer. The gateway
 * supplies it, and a token that names one still wins so a second tenant needs
 * no migration.
 */
describe('vendor_id defaults', () => {
  it('accepts a token with no vendor_id at all', () => {
    const claims = verifier.verify(sign({ customer_id: 'c1', phone: '0512345678' }));
    expect(claims.vendor_id).toBe('1');
    expect(claims.customer_id).toBe('c1');
  });

  it('treats a blank vendor_id as absent rather than rejecting it', () => {
    // An integrator sending "" is likelier than one omitting the field, and
    // failing there costs a support round-trip to explain a space.
    const claims = verifier.verify(
      sign({ vendor_id: '   ', customer_id: 'c1', phone: '0512345678' }),
    );
    expect(claims.vendor_id).toBe('1');
  });

  it('still honours a vendor_id the token DOES name', () => {
    const claims = verifier.verify(
      sign({ vendor_id: 'other-tenant', customer_id: 'c1', phone: '0512345678' }),
    );
    expect(claims.vendor_id).toBe('other-tenant');
  });

  it('still requires customer_id — the order lookup depends on it', () => {
    expect(() => verifier.verify(sign({ phone: '0512345678' }))).toThrow(CustomerTokenError);
  });
});
