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
