import { describe, it, expect } from 'vitest';
import {
  createEnvVendorSecrets,
  vendorEnvSegment,
  vendorSecretEnvNames,
  YIJI_VENDOR_KEY,
} from '../src/vendor-secrets.js';

describe('vendor secret naming (MV-3)', () => {
  it('keeps the Yiji vendor on its existing variables', () => {
    expect(vendorSecretEnvNames(YIJI_VENDOR_KEY)).toEqual({
      jwt: 'YIJI_JWT_SECRET',
      webhook: 'YIJI_WEBHOOK_SECRET',
    });
  });

  it('names every other vendor VENDOR_<KEY>_*', () => {
    expect(vendorSecretEnvNames('acme')).toEqual({
      jwt: 'VENDOR_ACME_JWT_SECRET',
      webhook: 'VENDOR_ACME_WEBHOOK_SECRET',
    });
  });

  it('upper-cases the key and turns non-alphanumerics into _', () => {
    expect(vendorEnvSegment('acme-foods')).toBe('ACME_FOODS');
    expect(vendorSecretEnvNames('acme-foods-2').jwt).toBe('VENDOR_ACME_FOODS_2_JWT_SECRET');
  });
});

describe('createEnvVendorSecrets', () => {
  const env = {
    YIJI_JWT_SECRET: 'yiji-jwt',
    YIJI_WEBHOOK_SECRET: 'yiji-wh',
    VENDOR_ACME_JWT_SECRET: 'acme-jwt',
    VENDOR_ACME_WEBHOOK_SECRET: 'acme-wh',
    VENDOR_BLANK_JWT_SECRET: '   ',
  };
  const secrets = createEnvVendorSecrets(env);

  it('returns Yiji secrets exactly as today', () => {
    expect(secrets.jwtSecret('yiji')).toBe('yiji-jwt');
    expect(secrets.webhookSecret('yiji')).toBe('yiji-wh');
  });

  it("returns a vendor's own secrets", () => {
    expect(secrets.jwtSecret('acme')).toBe('acme-jwt');
    expect(secrets.webhookSecret('acme')).toBe('acme-wh');
  });

  it("NEVER falls back to Yiji's secret for a vendor with none configured", () => {
    expect(secrets.jwtSecret('other')).toBeNull();
    expect(secrets.webhookSecret('other')).toBeNull();
  });

  it('treats a blank variable as missing', () => {
    expect(secrets.jwtSecret('blank')).toBeNull();
  });

  it('refuses keys that are not a valid webhook_path_key', () => {
    expect(secrets.jwtSecret('')).toBeNull();
    expect(secrets.jwtSecret('../yiji')).toBeNull();
    expect(secrets.webhookSecret('a b')).toBeNull();
  });

  it('does not fall back when Yiji itself is unconfigured', () => {
    expect(createEnvVendorSecrets({}).webhookSecret('yiji')).toBeNull();
  });
});
